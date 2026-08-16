import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
});
