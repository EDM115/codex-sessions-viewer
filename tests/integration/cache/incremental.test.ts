import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import {
  SessionCacheUpdater,
  type StableJsonlReader,
} from "../../../server/cache/sourceManifest.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import * as lineageReader from "../../../server/ingestion/rolloutLineage.ts";
import { normalizeSession } from "../../../server/normalization/normalizeSession.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const directory = join(process.cwd(), ".tmp", "task2-tests");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, "codex-viewer-incremental-"));
  temporaryRoots.push(root);
  return root;
}

async function fixture(name: "legacy.jsonl" | "modern.jsonl"): Promise<string> {
  return readFile(join(process.cwd(), "tests", "fixtures", "rollouts", name), "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("incremental session cache", () => {
  it.each(["body", "display-header", "history-base"] as const)(
    "rejects a %s rewrite between the first current read and lineage composition",
    async (changedPart) => {
      const root = await temporaryRoot();
      const path = join(root, "source.jsonl");
      const id = "11111111-1111-4111-8111-111111111111";
      const baseId = "22222222-2222-4222-8222-222222222222";
      const baseHeader =
        JSON.stringify({ type: "session_meta", payload: { id: baseId, session_id: "base-root" } }) +
        "\n";
      const baseText =
        baseHeader +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "inherited base" },
        }) +
        "\n";
      await mkdir(join(root, "sessions"));
      await writeFile(
        join(root, "sessions", `rollout-2026-10-27T10-00-00-${baseId}.jsonl`),
        baseText,
      );
      const header = {
        type: "session_meta",
        payload: {
          id,
          session_id: "root-a",
          subagent_history_start_ordinal: 3,
          history_base: {
            thread_id: baseId,
            end_ordinal_exclusive: 2,
            end_byte_offset: Buffer.byteLength(baseText),
          },
        },
      };
      const original = [
        header,
        { type: "event_msg", payload: { type: "user_message", message: "generation A" } },
      ]
        .map((value) => JSON.stringify(value) + "\n")
        .join("");
      const replacement =
        changedPart === "body"
          ? original.replace("generation A", "generation B")
          : changedPart === "display-header"
            ? original.replace(
                '"subagent_history_start_ordinal":3',
                '"subagent_history_start_ordinal":4',
              )
            : original
                .replace('"end_ordinal_exclusive":2', '"end_ordinal_exclusive":1')
                .replace(
                  `"end_byte_offset":${Buffer.byteLength(baseText)}`,
                  `"end_byte_offset":${Buffer.byteLength(baseHeader)}`,
                );
      await writeFile(path, original);
      const database = openCacheDatabase(":memory:");
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let pending: Promise<unknown> | undefined;
      try {
        expect(
          (await new SessionCacheUpdater(database).update({ path, scope: "active" })).status,
        ).toBe("updated");
        const before = getCachedSession(database, id);
        const oldManifest = database
          .prepare("SELECT sha256, generation_json FROM source_files WHERE path = ?")
          .get(path);
        const actualRead = lineageReader.readPlainRolloutLineage;
        const spy = vi
          .spyOn(lineageReader, "readPlainRolloutLineage")
          .mockImplementationOnce(async (...args) => {
            entered();
            await gate;
            return actualRead(...args);
          });
        try {
          pending = new SessionCacheUpdater(database).update(
            { path, scope: "active" },
            { force: true },
          );
          await paused;
          await writeFile(path, replacement);
          release();
          expect(await pending).toMatchObject({ status: "failed", retainedSessionId: id });
          expect(getCachedSession(database, id)).toEqual(before);
          expect(
            database
              .prepare("SELECT sha256, generation_json FROM source_files WHERE path = ?")
              .get(path),
          ).toEqual(oldManifest);
        } finally {
          release();
          await pending;
          spy.mockRestore();
        }
        const updated = await new SessionCacheUpdater(database).update({ path, scope: "active" });
        expect(updated.status).toBe("updated");
        expect(
          database.prepare("SELECT sha256 FROM source_files WHERE path = ?").get(path)?.["sha256"],
        ).toBe(createHash("sha256").update(replacement).digest("hex"));
      } finally {
        release();
        database.close();
      }
    },
  );
  it("rejects a late worker across updater instances without overwriting the newer generation", async () => {
    const root = await temporaryRoot();
    const path = join(root, "source.jsonl");
    const original = await fixture("modern.jsonl");
    await writeFile(path, original);
    const date = (await stat(path)).mtime;
    const database = openCacheDatabase(":memory:");
    let unblock!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = new SessionCacheUpdater(database, {
      async readJsonl(sourcePath, options) {
        const result = await readStableJsonl(sourcePath, options);
        started();
        await gate;
        return result;
      },
    });
    try {
      const old = slow.update({ path, scope: "active" });
      await reading;
      await writeFile(path, original.replace("Build the parser", "Build NEW parser"));
      await utimes(path, date, date);
      const current = await new SessionCacheUpdater(database).update({ path, scope: "active" });
      expect(current.status).toBe("updated");
      unblock();
      expect((await old).status).toBe("superseded");
      if (current.status !== "updated") {
        throw new Error("Expected the new generation to commit");
      }
      expect(getCachedSession(database, current.sessionId)?.summary.preview).toBe(
        "Build NEW parser",
      );
    } finally {
      unblock();
      database.close();
    }
  });
  it("materializes bounded ancestry and revalidates changed bases when the current file is unchanged", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "sessions");
    await mkdir(directory);
    const id = "11111111-1111-4111-8111-111111111111";
    const physical = "22222222-2222-4222-8222-222222222222";
    const base = join(directory, `rollout-2026-10-27T10-00-00-${id}.jsonl`);
    const path = join(directory, `rollout-2026-10-27T10-00-01-${id}_${physical}.jsonl`);
    const body = [
      { type: "session_meta", payload: { id } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "shared-turn" } },
      { type: "event_msg", payload: { type: "user_message", message: "old base prompt" } },
    ]
      .map((value) => JSON.stringify(value) + "\n")
      .join("");
    await writeFile(base, body);
    await writeFile(
      path,
      [
        {
          type: "session_meta",
          payload: {
            id,
            history_base: {
              thread_id: id,
              end_ordinal_exclusive: 3,
              end_byte_offset: Buffer.byteLength(body),
            },
          },
        },
        { type: "event_msg", payload: { type: "agent_message", message: "current answer" } },
      ]
        .map((value) => JSON.stringify(value) + "\n")
        .join(""),
    );
    const database = openCacheDatabase(":memory:");
    try {
      const updater = new SessionCacheUpdater(database);
      expect((await updater.update({ path, scope: "active" })).status).toBe("updated");
      expect(getCachedSession(database, id)?.summary.preview).toBe("old base prompt");
      const oldRevision = getCachedSession(database, id)?.summary.revision;
      const date = (await stat(base)).mtime;
      await writeFile(base, body.replace("old base prompt", "new base prompt"));
      await utimes(base, date, date);
      expect((await updater.update({ path, scope: "active" })).status).toBe("updated");
      expect(getCachedSession(database, id)?.summary.preview).toBe("new base prompt");
      expect(getCachedSession(database, id)?.summary.revision).not.toBe(oldRevision);
    } finally {
      database.close();
    }
  });
  it("invalidates a same-size rewrite with preserved timestamps even after restart", async () => {
    const root = await temporaryRoot();
    const path = join(root, "source.jsonl");
    const original = await fixture("modern.jsonl");
    const date = new Date("2026-01-01T00:00:00Z");
    await writeFile(path, original);
    await utimes(path, date, date);
    const database = openCacheDatabase(":memory:");
    try {
      const first = await new SessionCacheUpdater(database).update({ path, scope: "active" });
      expect(first.status).toBe("updated");
      await writeFile(path, original.replace("Build the parser", "Build NEW parser"));
      await utimes(path, date, date);
      const second = await new SessionCacheUpdater(database).update({ path, scope: "active" });
      expect(second.status).toBe("updated");
      if (second.status !== "updated") {
        throw new Error("Expected changed bytes to invalidate the persisted cache");
      }
      expect(getCachedSession(database, second.sessionId)?.summary.preview).toBe(
        "Build NEW parser",
      );
    } finally {
      database.close();
    }
  });
  it("drops advanced memo state after a rejected cache commit and retains the last good revision", async () => {
    const root = await temporaryRoot();
    const path = join(root, "source.jsonl");
    await writeFile(path, await fixture("modern.jsonl"));
    const database = openCacheDatabase(":memory:");
    const updater = new SessionCacheUpdater(database);
    try {
      const first = await updater.update({ path, scope: "active" });
      if (first.status !== "updated") {
        throw new Error("Expected initial source normalization");
      }
      const before = getCachedSession(database, first.sessionId);
      expect(updater.retention.sources).toBe(1);
      database.exec(
        "CREATE TEMP TRIGGER reject_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic write rejection'); END;",
      );
      await appendFile(
        path,
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "a large rejected candidate ".repeat(10_000) },
        }) + "\n",
      );
      await expect(updater.update({ path, scope: "active" })).resolves.toMatchObject({
        status: "failed",
      });
      expect(updater.retention).toMatchObject({ sources: 0, bytes: 0 });
      expect(getCachedSession(database, first.sessionId)).toEqual(before);
      database.exec("DROP TRIGGER reject_session_update");
      await expect(updater.update({ path, scope: "active" })).resolves.toMatchObject({
        status: "updated",
        mode: "full",
      });
    } finally {
      database.close();
    }
  });

  it("bounds retained source state by both LRU count and bytes and reparses an evicted session", async () => {
    const root = await temporaryRoot();
    const database = openCacheDatabase(":memory:");
    const source = await fixture("modern.jsonl");
    const paths = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const path = join(root, `source-${index}.jsonl`);
        await writeFile(
          path,
          source.replaceAll(
            "11111111-1111-4111-8111-111111111111",
            `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
          ),
        );
        return path;
      }),
    );
    const updater = new SessionCacheUpdater(database, {
      maxRetainedSources: 2,
      maxRetainedBytes: 2_000_000,
    });
    try {
      for (const path of paths) {
        // oxlint-disable-next-line no-await-in-loop -- Access order determines the LRU eviction under test.
        await updater.update({ path, scope: "active" });
      }
      expect(updater.retention.sources).toBe(2);
      expect(updater.retention.bytes).toBeLessThanOrEqual(2_000_000);
      await appendFile(paths[0]!, "\n");
      await expect(updater.update({ path: paths[0]!, scope: "active" })).resolves.toMatchObject({
        status: "updated",
        mode: "full",
      });
      const tiny = new SessionCacheUpdater(database, {
        maxRetainedSources: 2,
        maxRetainedBytes: 1,
      });
      await tiny.update({ path: paths[0]!, scope: "active" }, { force: true });
      expect(tiny.retention).toMatchObject({ sources: 0, bytes: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps incomplete trailing JSON pending and detects same-size rewrites and replacement", async () => {
    const root = await temporaryRoot();
    const path = join(root, "source.jsonl");
    const original = await fixture("modern.jsonl");
    await writeFile(path, original);
    const database = openCacheDatabase(":memory:");
    const updater = new SessionCacheUpdater(database);
    try {
      const first = await updater.update({ path, scope: "active" });
      if (first.status !== "updated") {
        throw new Error("Initial normalization failed");
      }
      const fragment =
        '{"type":"event_msg","payload":{"type":"agent_message","message":"Split Unicode é';
      await appendFile(path, fragment);
      await expect(updater.update({ path, scope: "active" })).resolves.toMatchObject({
        status: "updated",
        mode: "append",
      });
      expect(getCachedSession(database, first.sessionId)?.summary.assistantMessageCount).toBe(2);
      await appendFile(path, '"}}\n');
      await expect(updater.update({ path, scope: "active" })).resolves.toMatchObject({
        status: "updated",
        mode: "append",
      });
      expect(
        getCachedSession(database, first.sessionId)?.turns.at(-1)?.assistantMessages.at(-1)
          ?.sourceMarkdown,
      ).toBe("Split Unicode é");
      const complete = await readFile(path, "utf8");
      await writeFile(path, complete.replace("Split Unicode", "Other Unicode"));
      await utimes(path, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      await expect(updater.update({ path, scope: "active" })).resolves.toMatchObject({
        status: "updated",
        mode: "full",
      });
      expect(
        getCachedSession(database, first.sessionId)?.turns.at(-1)?.assistantMessages.at(-1)
          ?.sourceMarkdown,
      ).toBe("Other Unicode é");
      await rm(path);
      await writeFile(path, original);
      await expect(updater.update({ path, scope: "active" })).resolves.toMatchObject({
        status: "updated",
        mode: "full",
      });
      expect(getCachedSession(database, first.sessionId)?.summary.assistantMessageCount).toBe(2);
    } finally {
      database.close();
    }
  });
  it("trusts a persisted unchanged fingerprint after restart without retransformation", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "modern.jsonl");
    const cachePath = join(root, "viewer.sqlite");
    const source = await fixture("modern.jsonl");
    await writeFile(sourcePath, source, "utf8");
    const firstDatabase = openCacheDatabase(cachePath);
    const firstNormalize = vi.fn<typeof normalizeSession>(normalizeSession);

    try {
      const firstUpdater = new SessionCacheUpdater(firstDatabase, { normalize: firstNormalize });
      await expect(
        firstUpdater.update({ path: sourcePath, scope: "active" }),
      ).resolves.toMatchObject({
        status: "updated",
        mode: "full",
        fingerprint: { sha256: createHash("sha256").update(source).digest("hex") },
      });
      expect(firstNormalize).toHaveBeenCalledOnce();
    } finally {
      firstDatabase.close();
    }

    const restartedDatabase = openCacheDatabase(cachePath);
    const restartedNormalize = vi.fn<typeof normalizeSession>(normalizeSession);
    try {
      const restartedUpdater = new SessionCacheUpdater(restartedDatabase, {
        normalize: restartedNormalize,
      });
      await expect(
        restartedUpdater.update({ path: sourcePath, scope: "active" }),
      ).resolves.toMatchObject({ status: "unchanged" });
      expect(restartedNormalize).not.toHaveBeenCalled();
      expect(await readFile(sourcePath, "utf8")).toBe(source);
    } finally {
      restartedDatabase.close();
    }
  });

  it("reuses normalized content when only the source mtime changed", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "modern.jsonl");
    await writeFile(sourcePath, await fixture("modern.jsonl"), "utf8");
    const database = openCacheDatabase(":memory:");
    const readJsonl = vi.fn<typeof readStableJsonl>(readStableJsonl);
    const normalize = vi.fn<typeof normalizeSession>(normalizeSession);
    const updater = new SessionCacheUpdater(database, { normalize, readJsonl });

    try {
      const first = await updater.update({ path: sourcePath, scope: "active" });
      expect(first).toMatchObject({ status: "updated", mode: "full" });
      readJsonl.mockClear();
      normalize.mockClear();
      const touchedAt = new Date(Date.now() + 5_000);
      await utimes(sourcePath, touchedAt, touchedAt);

      const touched = await updater.update({ path: sourcePath, scope: "active" });
      expect(touched).toMatchObject({ status: "unchanged" });
      if (touched.status !== "unchanged") {
        throw new Error("Expected an mtime-only source touch to reuse the cached session");
      }
      expect(touched.fingerprint.mtimeMs).toBeCloseTo((await stat(sourcePath)).mtimeMs, 3);
      expect(readJsonl).not.toHaveBeenCalled();
      expect(normalize).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("reparses an unchanged source when the normalized parser version advances", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "modern.jsonl");
    const cachePath = join(root, "viewer.sqlite");
    await writeFile(sourcePath, await fixture("modern.jsonl"), "utf8");
    const oldDatabase = openCacheDatabase(cachePath);
    try {
      const oldUpdater = new SessionCacheUpdater(oldDatabase, { parserVersion: 1 });
      await expect(oldUpdater.update({ path: sourcePath, scope: "active" })).resolves.toMatchObject(
        {
          status: "updated",
        },
      );
    } finally {
      oldDatabase.close();
    }

    const upgradedDatabase = openCacheDatabase(cachePath);
    const upgradedNormalize = vi.fn<typeof normalizeSession>(normalizeSession);
    try {
      const upgradedUpdater = new SessionCacheUpdater(upgradedDatabase, {
        normalize: upgradedNormalize,
      });
      await expect(
        upgradedUpdater.update({ path: sourcePath, scope: "active" }),
      ).resolves.toMatchObject({ status: "updated", mode: "full" });
      expect(upgradedNormalize).toHaveBeenCalledOnce();
    } finally {
      upgradedDatabase.close();
    }
  });

  it("appends one growing session from memory and fully reparses it after truncation", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "modern.jsonl");
    const source = await fixture("modern.jsonl");
    await writeFile(sourcePath, source, "utf8");
    const database = openCacheDatabase(":memory:");
    const updater = new SessionCacheUpdater(database);

    try {
      const first = await updater.update({ path: sourcePath, scope: "active" });
      expect(first).toMatchObject({ status: "updated", mode: "full" });
      if (first.status !== "updated") {
        throw new Error("Expected the initial source update to succeed");
      }
      const before = getCachedSession(database, first.sessionId);
      const appended = [
        '{"timestamp":"2026-01-01T10:00:21.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-3"}}',
        '{"timestamp":"2026-01-01T10:00:22.000Z","type":"event_msg","payload":{"type":"user_message","message":"Append one turn","images":[],"local_images":[]}}',
        '{"timestamp":"2026-01-01T10:00:23.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-3","last_agent_message":"Done"}}',
      ].join("\n");
      await appendFile(sourcePath, `${appended}\n`, "utf8");

      const append = await updater.update({ path: sourcePath, scope: "active" });
      expect(append).toMatchObject({ status: "updated", mode: "append" });
      if (append.status !== "updated") {
        throw new Error("Expected the appended source update to succeed");
      }
      expect(append.fingerprint.sha256).toBe(
        createHash("sha256")
          .update(await readFile(sourcePath))
          .digest("hex"),
      );
      const afterAppend = getCachedSession(database, first.sessionId);
      expect(afterAppend?.summary.revision).not.toBe(before?.summary.revision);
      expect(afterAppend?.summary.turnCount).toBe((before?.summary.turnCount ?? 0) + 1);

      const truncated = source.split("\n").slice(0, 10).join("\n") + "\n";
      await writeFile(sourcePath, truncated, "utf8");
      const reparse = await updater.update({ path: sourcePath, scope: "active" });
      expect(reparse).toMatchObject({ status: "updated", mode: "full" });
      expect(getCachedSession(database, first.sessionId)?.summary.turnCount).toBe(1);
    } finally {
      database.close();
    }
  });

  it("does not retain parsed source state when static scanning disables append reuse", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "modern.jsonl");
    await writeFile(sourcePath, await fixture("modern.jsonl"), "utf8");
    const database = openCacheDatabase(":memory:");
    const updater = new SessionCacheUpdater(database, { retainLiveSources: false });

    try {
      await expect(updater.update({ path: sourcePath, scope: "active" })).resolves.toMatchObject({
        status: "updated",
        mode: "full",
      });
      await appendFile(
        sourcePath,
        '{"timestamp":"2026-01-01T10:00:24.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Static append"}}\n',
        "utf8",
      );

      await expect(updater.update({ path: sourcePath, scope: "active" })).resolves.toMatchObject({
        status: "updated",
        mode: "full",
      });
    } finally {
      database.close();
    }
  });

  it("keeps the last good normalized revision when the source changes during a read", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "modern.jsonl");
    await writeFile(sourcePath, await fixture("modern.jsonl"), "utf8");
    let disturbRead = false;
    const reader: StableJsonlReader = (path, options) =>
      readStableJsonl(path, {
        ...options,
        async afterChunk(chunk) {
          await options.afterChunk?.(chunk);
          if (disturbRead) {
            disturbRead = false;
            await appendFile(
              sourcePath,
              '{"timestamp":"2026-01-01T10:00:25.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Changed concurrently"}}\n',
              "utf8",
            );
          }
        },
      });
    const database = openCacheDatabase(":memory:");
    const updater = new SessionCacheUpdater(database, { readJsonl: reader });

    try {
      const first = await updater.update({ path: sourcePath, scope: "active" });
      if (first.status !== "updated") {
        throw new Error("Expected the initial source update to succeed");
      }
      const before = getCachedSession(database, first.sessionId);
      await appendFile(
        sourcePath,
        '{"timestamp":"2026-01-01T10:00:24.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Trigger changed stat"}}\n',
        "utf8",
      );
      disturbRead = true;

      await expect(updater.update({ path: sourcePath, scope: "active" })).resolves.toMatchObject({
        status: "failed",
        retainedSessionId: first.sessionId,
      });
      expect(getCachedSession(database, first.sessionId)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("persists a source-level cache failure until that source updates successfully", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "modern.jsonl");
    await writeFile(sourcePath, await fixture("modern.jsonl"), "utf8");
    const database = openCacheDatabase(":memory:");
    let shouldFail = true;
    const updater = new SessionCacheUpdater(database, {
      normalize(input) {
        if (shouldFail) {
          throw new Error("Synthetic normalization failure");
        }
        return normalizeSession(input);
      },
    });

    try {
      await expect(updater.update({ path: sourcePath, scope: "active" })).resolves.toMatchObject({
        status: "failed",
        retainedSessionId: null,
        diagnostics: [
          expect.objectContaining({
            code: "cache.unavailable",
            path: sourcePath,
            details: { error: "Synthetic normalization failure" },
          }),
        ],
      });
      expect(
        database
          .prepare("SELECT session_id, code, path, details_json FROM diagnostics WHERE path = ?")
          .all(sourcePath),
      ).toEqual([
        {
          session_id: null,
          code: "cache.unavailable",
          path: sourcePath,
          details_json: '{"error":"Synthetic normalization failure"}',
        },
      ]);

      shouldFail = false;
      await expect(updater.update({ path: sourcePath, scope: "active" })).resolves.toMatchObject({
        status: "updated",
      });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM diagnostics WHERE path = ?")
          .get(sourcePath),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
