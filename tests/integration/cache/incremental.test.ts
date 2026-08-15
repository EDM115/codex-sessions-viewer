import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import {
  SessionCacheUpdater,
  type StableJsonlReader,
} from "../../../server/cache/sourceManifest.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { normalizeSession } from "../../../server/normalization/normalizeSession.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-incremental-"));
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
