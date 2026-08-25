import { mkdir, mkdtemp, open, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { selectSessionSources } from "../../../server/ingestion/selectSessionSources.ts";
import {
  readSessionMetaPrefix,
  type SessionMetaPrefixFile,
} from "../../../server/ingestion/sessionMetaPrefix.ts";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "catalog");

describe("readSessionMetaPrefix", () => {
  it("reads only the bounded prefix and parses root, subagent, and guardian metadata", async () => {
    const readCalls: Array<{ offset: number; length: number; position: number }> = [];
    const openFile = async (path: string): Promise<SessionMetaPrefixFile> => {
      const handle = await open(path, "r");
      return {
        async read(buffer, offset, length, position) {
          readCalls.push({ offset, length, position });
          return handle.read(buffer, offset, length, position);
        },
        close: () => handle.close(),
      };
    };

    const results = await Promise.all(
      ["root.jsonl", "subagent.jsonl", "guardian.jsonl"].map((name) =>
        readSessionMetaPrefix(join(fixtureRoot, name), 4_096, { openFile }),
      ),
    );
    const root = results[0];
    const subagent = results[1]!;
    const guardian = results[2]!;

    expect(root).toMatchObject({ status: "found", meta: { id: "root" } });
    expect(subagent.meta?.source).toEqual({
      subagent: {
        thread_spawn: {
          parent_thread_id: "root",
          depth: 1,
          agent_path: "/root/review",
          agent_nickname: "Fermat",
        },
      },
    });
    expect(guardian.meta?.source).toEqual({
      subagent: { other: "guardian", parent_thread_id: "root" },
    });
    expect(readCalls).toHaveLength(3);
    expect(readCalls.every(({ offset, position }) => offset === 0 && position === 0)).toBe(true);
    expect(readCalls.every(({ length }) => length <= 4_096)).toBe(true);
  });

  it("does not parse incomplete or oversized records and rejects linked sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-session-prefix-"));
    const incomplete = join(root, "incomplete.jsonl");
    const oversized = join(root, "oversized.jsonl");
    const linked = join(root, "linked.jsonl");
    await writeFile(incomplete, '{"type":"session_meta","payload":{"id":"incomplete"}}', "utf8");
    await writeFile(
      oversized,
      `${JSON.stringify({ type: "session_meta", payload: { id: "oversized", parent_thread_id: "parent", padding: "x".repeat(8_192) } })}\n`,
      "utf8",
    );
    await symlink(incomplete, linked, "file");

    try {
      await expect(readSessionMetaPrefix(incomplete, 4_096)).resolves.toMatchObject({
        status: "missing",
        meta: null,
      });
      await expect(readSessionMetaPrefix(oversized, 512)).resolves.toMatchObject({
        status: "missing",
        meta: null,
        parentThreadIdHint: "parent",
        bytesRead: 512,
      });
      await expect(readSessionMetaPrefix(linked, 4_096)).rejects.toThrow("regular rollout file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discards parsed metadata when the source observation changes", async () => {
    const path = join(fixtureRoot, "root.jsonl");
    let observation = 0;
    const result = await readSessionMetaPrefix(path, 4_096, {
      async observeFile() {
        observation += 1;
        return {
          device: 1n,
          inode: 2n,
          size: 400n,
          mtimeNs: BigInt(observation),
          ctimeNs: 1n,
          regular: true,
          symbolicLink: false,
        };
      },
    });

    expect(result).toMatchObject({ status: "changed", meta: null });
  });

  it("fully reads only duplicate groups and excludes changing or incomplete candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-source-selection-"));
    const active = join(root, "sessions", "active.jsonl");
    const archived = join(root, "archived_sessions", "archived.jsonl");
    const incomplete = join(root, "sessions", "incomplete.jsonl");
    const changing = join(root, "sessions", "changing.jsonl");
    const unique = join(root, "sessions", "unique.jsonl");
    await Promise.all([
      mkdir(join(root, "sessions"), { recursive: true }),
      mkdir(join(root, "archived_sessions"), { recursive: true }),
    ]);
    const fixture = await readFile(
      join(process.cwd(), "tests", "fixtures", "rollouts", "modern.jsonl"),
      "utf8",
    );
    await Promise.all([
      writeFile(active, fixture.replace("Build the parser", "Active older"), "utf8"),
      writeFile(archived, fixture.replace("Build the parser", "Archived winner"), "utf8"),
      writeFile(incomplete, fixture.trimEnd(), "utf8"),
      writeFile(changing, fixture.replace("Build the parser", "Changing newest"), "utf8"),
      writeFile(
        unique,
        fixture.replaceAll(
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ),
        "utf8",
      ),
    ]);
    const now = Date.now() / 1_000;
    await Promise.all([
      utimes(active, now - 50, now - 50),
      utimes(archived, now - 40, now - 40),
      utimes(incomplete, now - 30, now - 30),
      utimes(changing, now - 20, now - 20),
      utimes(unique, now - 10, now - 10),
    ]);
    const readPrefix = vi.fn<typeof readSessionMetaPrefix>(readSessionMetaPrefix);
    const readJsonl = vi.fn<typeof readStableJsonl>(async (path, options) => {
      const result = await readStableJsonl(path, options);
      return path === changing
        ? { ...result, read: { status: "changed", retry: true, bytesRead: 0 } }
        : result;
    });

    try {
      const result = await selectSessionSources(
        [
          { path: active, scope: "active" },
          { path: archived, scope: "archived" },
          { path: incomplete, scope: "active" },
          { path: changing, scope: "active" },
          { path: unique, scope: "active" },
        ],
        { readPrefix, readJsonl },
      );

      expect(readPrefix).toHaveBeenCalledTimes(5);
      expect(readPrefix.mock.calls.every(([, maxBytes]) => maxBytes === 4_096)).toBe(true);
      expect(readJsonl).toHaveBeenCalledTimes(4);
      expect(readJsonl.mock.calls.map(([path]) => path)).not.toContain(unique);
      expect(result.selected.map(({ source }) => source)).toEqual([
        { path: archived, scope: "archived" },
        { path: unique, scope: "active" },
      ]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "source.duplicate_session",
          details: { candidateCount: 4, selectedPath: archived },
        }),
      ]);
      expect(result.selected.every((entry) => !("records" in entry))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
