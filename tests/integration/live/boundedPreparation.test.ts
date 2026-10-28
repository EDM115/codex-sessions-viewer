import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { upsertCatalogSessions } from "../../../server/cache/catalogStore.ts";
import { getCachedSession, replaceCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import {
  SessionCacheUpdater,
  getSourceManifestEntry,
} from "../../../server/cache/sourceManifest.ts";
import * as richText from "../../../server/content/parseRichText.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { rolloutRefFromSource } from "../../../server/ingestion/rolloutIdentity.ts";
import { InvalidationBus } from "../../../server/live/invalidationBus.ts";
import { LiveReconciler } from "../../../server/live/reconciler.ts";
import { LiveConversationRepository } from "../../../server/live/repository.ts";
import { readCatalogMetadata } from "../../../server/metadata/catalogMetadata.ts";
import { normalizeSession } from "../../../server/normalization/normalizeSession.ts";
import type { NormalizedSession } from "../../../server/normalization/normalizeSession.ts";
import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";
import { representativeLargeSession } from "../../performance/fixtures.ts";
import { createStateDatabase } from "../source-boundary/fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "viewer-bounded-"));
  roots.push(path);
  return path;
}

async function storeVerifiedFixture(database: DatabaseSync, session: NormalizedSession) {
  let source = getSourceManifestEntry(database, session.summary.sourcePath)!;
  if (source === null) {
    await writeFile(
      session.summary.sourcePath,
      await readFile(join(process.cwd(), "tests/fixtures/rollouts/modern.jsonl")),
    );
    const result = await new SessionCacheUpdater(database).update({
      path: session.summary.sourcePath,
      scope: session.summary.scope,
    });
    if (result.status !== "updated") {
      throw new Error(`Fixture source was not verified: ${JSON.stringify(result)}`);
    }
    source = getSourceManifestEntry(database, session.summary.sourcePath)!;
  }
  replaceCachedSession(database, {
    session,
    diagnostics: [],
    source: {
      fingerprint: source.fingerprint,
      identity: source.identity,
      scope: source.scope,
      ...(source.generation === null ? {} : { generation: source.generation }),
    },
  });
}

describe("production live preparation boundaries", () => {
  it("recovers failed enrichment and rejects old rich payloads when normalized content advances mid-parse", async () => {
    const cacheDir = await root();
    const session = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(cacheDir, "racing.jsonl"),
      scope: "active",
      revision: "sha256:before-rich",
    });
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    await storeVerifiedFixture(database, session);
    const reconciler = new LiveReconciler({
      database,
      bus,
      cacheDir,
      codexHome: cacheDir,
      fetchFavicons: false,
    });
    const repository = new LiveConversationRepository(database, bus, reconciler);
    const parse = vi.spyOn(richText, "parseRichText");
    parse.mockRejectedValueOnce(new Error("recoverable rich parser failure"));
    try {
      await expect(
        repository.getTurns(session.summary.id, { cursor: "0", limit: 1 }),
      ).rejects.toThrow("recoverable rich parser failure");
      expect(
        database.prepare("SELECT rich_revision FROM turns WHERE turn_index = 0").get()?.[
          "rich_revision"
        ],
      ).toBeNull();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actual = parse.getMockImplementation();
      parse.mockImplementationOnce(async (...args) => {
        entered();
        await held;
        return actual!(...args);
      });
      const opening = repository.getTurns(session.summary.id, { cursor: "0", limit: 1 });
      await started;
      session.summary.revision = "sha256:after-rich";
      const prompt = session.turns[0]!.userMessage!;
      prompt.sourceMarkdown = "A new prompt supersedes the in-flight rich page";
      prompt.body = { type: "document", children: [{ type: "text", text: prompt.sourceMarkdown }] };
      await storeVerifiedFixture(database, session);
      release();
      const latest = await opening;
      expect(latest.revision).toBe("sha256:after-rich");
      expect(latest.turns[0]?.userMessage?.sourceMarkdown).toBe(prompt.sourceMarkdown);
      expect(
        database.prepare("SELECT rich_revision FROM turns WHERE turn_index = 0").get()?.[
          "rich_revision"
        ],
      ).toBe("sha256:after-rich");
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("preserves parent-wide guardian ambiguity across pages and removes invalidated approval evidence", async () => {
    const cacheDir = await root();
    const session = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(cacheDir, "parent.jsonl"),
      scope: "active",
      revision: "sha256:guardian-parent",
    });
    const tool = session.turns[0]!.activities.find((activity) => activity.kind === "tool")!;
    const second = session.turns[1]!;
    second.activities = [{ ...tool, id: "second-tool", turnId: second.id }];
    session.turns[0]!.activities = [tool];
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    await storeVerifiedFixture(database, session);
    const guardianId = "22222222-2222-4222-8222-222222222222";
    const guardianPath = join(cacheDir, "guardian.jsonl");
    await writeFile(
      guardianPath,
      [
        {
          type: "session_meta",
          payload: {
            id: guardianId,
            parent_thread_id: session.summary.id,
            source: { subagent: { other: "guardian", parent_thread_id: session.summary.id } },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: `Planned action JSON:\n${JSON.stringify(tool.input)}`,
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: '{"risk_level":"low","outcome":"allow","rationale":"Exact reviewed action"}',
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    upsertCatalogSessions(database, [
      {
        summary: {
          ...session.summary,
          id: guardianId,
          sourcePath: guardianPath,
          parentThreadId: session.summary.id,
        },
        kind: "auxiliary",
        materialization: "cold",
        project: { id: "none", name: "No project", source: "none", hint: null },
        parentThreadId: session.summary.id,
        agentPath: null,
        agentNickname: null,
        agentDepth: 1,
        childCount: 0,
        sourceSize: 1,
        sourceMtimeMs: 1,
        sourceDevice: null,
        sourceInode: null,
        sourceRevision: "guardian:1",
        error: null,
      },
    ]);
    const reconciler = new LiveReconciler({
      database,
      bus,
      cacheDir,
      codexHome: cacheDir,
      fetchFavicons: false,
    });
    const repository = new LiveConversationRepository(database, bus, reconciler);
    try {
      for (const index of [0, 1]) {
        // oxlint-disable-next-line no-await-in-loop -- Separate pages must each preserve full-parent ambiguity.
        const chunk = await repository.getTurns(session.summary.id, {
          cursor: String(index),
          limit: 1,
        });
        expect(
          chunk.turns[0]?.activities.find((activity) => activity.kind === "tool")?.approval,
        ).toBeNull();
      }
      second.activities = [
        { ...tool, id: "second-tool", turnId: second.id, input: { path: "different-file" } },
      ];
      session.summary.revision = "sha256:guardian-unique";
      await storeVerifiedFixture(database, session);
      const unique = await repository.getTurns(session.summary.id, { cursor: "0", limit: 1 });
      expect(
        unique.turns[0]?.activities.find((activity) => activity.kind === "tool")?.approval?.outcome,
      ).toBeUndefined();
      expect(await repository.getApprovalEvidence(session.summary.id)).toMatchObject({
        unattached: [{ reason: "missing-tool-or-turn" }],
      });
      const qualified = (await readFile(guardianPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      qualified[0]!.payload["target_turn_id"] = tool.turnId;
      qualified[1]!.payload["message"] =
        `Planned action JSON:\n${JSON.stringify({ name: tool.name, namespace: tool.namespace, arguments: tool.input })}`;
      await writeFile(
        guardianPath,
        `${qualified.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      database
        .prepare("UPDATE turns SET rich_revision = NULL WHERE session_id = ?")
        .run(session.summary.id);
      const declared = await repository.getTurns(session.summary.id, { cursor: "0", limit: 1 });
      expect(
        declared.turns[0]?.activities.find((activity) => activity.kind === "tool")?.approval
          ?.outcome,
      ).toBe("allow");
      database.prepare("DELETE FROM session_catalog WHERE id = ?").run(guardianId);
      database
        .prepare("UPDATE turns SET rich_revision = NULL WHERE session_id = ?")
        .run(session.summary.id);
      const removed = await repository.getTurns(session.summary.id, { cursor: "0", limit: 1 });
      expect(
        removed.turns[0]?.activities.find((activity) => activity.kind === "tool")?.approval,
      ).toBeNull();
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("keeps all warm API readiness reads bounded and enriches only the requested page once", async () => {
    const cacheDir = await root();
    const source = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(cacheDir, "source.jsonl"),
      scope: "active",
      revision: "sha256:bounded",
    });
    const session = representativeLargeSession(source);
    session.rawEvents = Array.from({ length: 40 }, (_, index) => ({
      id: `unrelated-${index}`,
      turnId: null,
      type: "unknown",
      timestamp: null,
      payload: { text: "large unrelated payload ".repeat(20_000) },
    }));
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    await storeVerifiedFixture(database, session);
    const reconciler = new LiveReconciler({
      database,
      bus,
      cacheDir,
      codexHome: cacheDir,
      fetchFavicons: false,
    });
    const repository = new LiveConversationRepository(database, bus, reconciler);
    const parse = vi.spyOn(richText, "parseRichText");
    const sql: string[] = [];
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((statement) => {
      sql.push(statement.replaceAll(/\s+/gu, " ").trim());
      return prepare(statement);
    });
    try {
      await repository.getSession(session.summary.id);
      const navigator = await repository.getTurnNavigator(session.summary.id);
      expect(navigator.map(({ turnId }) => turnId)).toEqual(
        Array.from({ length: 500 }, (_, index) => `scale-turn-${index}`),
      );
      expect(navigator[487]).toEqual({
        turnId: "scale-turn-487",
        index: 487,
        userMessageId: "scale-user-487-0",
        promptPreview: "Handle cancellation",
        assistantPreview: "Working on it.",
        proseLengthBucket: 1,
        createdAt: "2026-01-01T10:00:16.000Z",
      });
      expect(parse).not.toHaveBeenCalled();
      const [first, duplicate, overlap] = await Promise.all([
        repository.getTurns(session.summary.id, { targetTurnId: "scale-turn-487", limit: 20 }),
        repository.getTurns(session.summary.id, { targetTurnId: "scale-turn-487", limit: 20 }),
        repository.getTurns(session.summary.id, { targetTurnId: "scale-turn-487", limit: 10 }),
      ]);
      expect(duplicate).toEqual(first);
      expect(overlap.turns).toEqual(first.turns.slice(0, 10));
      const parsedOnce = parse.mock.calls.length;
      expect(parsedOnce).toBe(50);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM turns WHERE rich_revision IS NOT NULL")
          .get()?.["count"],
      ).toBe(20);
      await repository.getTurns(session.summary.id, { targetTurnId: "scale-turn-487", limit: 20 });
      await repository.getInspector(session.summary.id, { type: "turn", id: "scale-turn-487" });
      expect(parse).toHaveBeenCalledTimes(parsedOnce);
      expect(sql).not.toContain(
        "SELECT payload_json FROM turns WHERE session_id = ? ORDER BY turn_index",
      );
      expect(sql).not.toContain(
        "SELECT payload_json FROM activities WHERE session_id = ? AND kind = 'tool'",
      );
      expect(
        sql.some((statement) =>
          /FROM raw_events WHERE session_id = \? ORDER BY source_order/u.test(statement),
        ),
      ).toBe(false);
      expect(
        sql
          .filter(
            (statement) =>
              statement.includes("FROM turns") &&
              statement.includes("ORDER BY turn_index") &&
              statement.includes("payload_json"),
          )
          .every((statement) => statement.includes("LIMIT")),
      ).toBe(true);
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("makes normalized summaries available independently of an expensive requested rich page", async () => {
    const cacheDir = await root();
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const session = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(cacheDir, "a.jsonl"),
      scope: "active",
      revision: "sha256:a",
    });
    session.turns[0]!.userMessage!.sourceMarkdown = "hold rich page A";
    session.turns[0]!.userMessage!.body = {
      type: "document",
      children: [{ type: "text", text: "hold rich page A" }],
    };
    await storeVerifiedFixture(database, session);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const actual = richText.parseRichText;
    vi.spyOn(richText, "parseRichText").mockImplementation(async (text, options) => {
      if (text === "hold rich page A") {
        entered();
        await held;
      }
      return actual(text, options);
    });
    const reconciler = new LiveReconciler({
      database,
      bus,
      cacheDir,
      codexHome: cacheDir,
      fetchFavicons: false,
    });
    const repository = new LiveConversationRepository(database, bus, reconciler);
    try {
      const rich = repository.getTurns(session.summary.id, { cursor: "0", limit: 1 });
      await started;
      await expect(repository.prepareSessions([session.summary.id])).resolves.toEqual([
        { id: session.summary.id, state: "ready", error: null },
      ]);
      await expect(repository.getSession(session.summary.id)).resolves.toMatchObject({
        id: session.summary.id,
      });
      const otherPage = await repository.getTurns(session.summary.id, { cursor: "1", limit: 1 });
      expect(otherPage.turns[0]?.index).toBe(1);
      release();
      await rich;
    } finally {
      release();
      await reconciler.close();
      database.close();
    }
  });

  it("uses append offsets through the real reconciler, preserves enriched earlier rows and recovers missing normalized storage", async () => {
    const cacheDir = await root();
    const directory = join(cacheDir, "sessions");
    await mkdir(directory);
    const path = join(directory, "source.jsonl");
    const original = await readFile(
      join(process.cwd(), "tests/fixtures/rollouts/modern.jsonl"),
      "utf8",
    );
    await writeFile(path, original);
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const offsets: number[] = [];
    const reconciler = new LiveReconciler({
      database,
      bus,
      cacheDir,
      codexHome: cacheDir,
      fetchFavicons: false,
      watch: () => ({ ready: new Promise<void>(() => {}), close: async () => {} }),
      readJsonl: async (source, options) => {
        offsets.push(options.start ?? 0);
        return readStableJsonl(source, options);
      },
    });
    const repository = new LiveConversationRepository(database, bus, reconciler);
    try {
      await reconciler.start();
      await reconciler.whenRecoverySettled();
      const id = String(database.prepare("SELECT id FROM session_catalog").get()?.["id"]);
      await repository.getTurns(id, { cursor: "0", limit: 1 });
      const stored = database
        .prepare("SELECT rowid, payload_json, rich_revision FROM turns WHERE turn_index = 0")
        .get();
      database.exec(
        "CREATE TEMP TABLE changed_turn_writes (id TEXT); CREATE TEMP TRIGGER observe_turn_inserts AFTER INSERT ON turns BEGIN INSERT INTO changed_turn_writes VALUES (new.id); END;",
      );
      const appended =
        '\n{"timestamp":"2026-01-01T10:01:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"append-final"}}\n{"timestamp":"2026-01-01T10:01:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"New unique prompt"}}\n';
      await appendFile(path, appended);
      await reconciler.reconcileNow();
      await repository.getSession(id);
      expect(offsets).toEqual([0, Buffer.byteLength(original)]);
      expect(database.prepare("SELECT id FROM changed_turn_writes").all()).toEqual([
        { id: "append-final" },
      ]);
      expect(
        database
          .prepare("SELECT rowid, payload_json, rich_revision FROM turns WHERE turn_index = 0")
          .get(),
      ).toEqual(stored);
      const read = await readStableJsonl(path);
      const cached = getCachedSession(database, id)!;
      const oracleRef = rolloutRefFromSource(path, null);
      oracleRef.physicalRolloutId = getSourceManifestEntry(
        database,
        path,
      )!.generation!.physicalRolloutId;
      const oracle = normalizeSession({
        rolloutRef: oracleRef,
        records: read.records,
        sourcePath: path,
        scope: "active",
        sessionIndexEntries: [],
        stateSnapshot: null,
        revision: cached.summary.revision,
      }).session!;
      expect(cached.summary).toEqual(oracle.summary);
      expect(cached.turns.at(-1)).toEqual(oracle.turns.at(-1));
      expect(cached.rawEvents).toEqual(oracle.rawEvents);
      expect(reconciler.retainedSourceState.sources).toBe(1);
      expect(reconciler.retainedSourceState.bytes).toBeLessThanOrEqual(
        reconciler.retainedSourceState.maxBytes,
      );
      database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      await expect(repository.getSession(id)).resolves.toMatchObject({ id });
      expect(offsets.at(-1)).toBe(0);
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("takes one fresh metadata snapshot without scheduling another scan on watcher readiness", async () => {
    const directory = await root();
    const codexHome = join(directory, "home");
    await mkdir(codexHome);
    const native = createStateDatabase(join(codexHome, "state_5.sqlite"));
    native.exec("DELETE FROM threads");
    native.close();
    const database = openCacheDatabase(":memory:");
    const readMetadata = vi.fn<typeof readCatalogMetadata>(readCatalogMetadata);
    const reconciler = new LiveReconciler({
      database,
      bus: new InvalidationBus(),
      cacheDir: join(directory, "cache"),
      codexHome,
      fetchFavicons: false,
      readMetadata,
      watch: () => ({ ready: Promise.resolve(), close: async () => {} }),
    });
    await reconciler.start();
    await reconciler.close();
    database.close();
    expect(readMetadata).toHaveBeenCalledOnce();
  });
});
