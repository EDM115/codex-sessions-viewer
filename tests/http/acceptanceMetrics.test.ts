import { appendFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { setup, $fetch, url } from "@nuxt/test-utils/e2e";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

import { LiveApiConversationRepository } from "~/repositories/live.ts";

import {
  addItem,
  addTurn,
  canonicalRecords,
  HISTORY_FIXTURE_SCHEMA,
} from "../fixtures/history/nativeHistory.ts";
import { createStateDatabase } from "../integration/source-boundary/fixtures.ts";

const root = await mkdtemp(join(tmpdir(), "viewer-production-metrics-"));
await setup({
  rootDir: resolve("tests/fixtures/nuxt-history"),
  dev: false,
  env: { VIEWER_TEST_ROOT: root },
  setupTimeout: 240000,
});
const observations: unknown[] = [];
interface Snapshot {
  runtimeOwner: string | null;
  fullReads: number;
  rolloutIo: number;
  rolloutOpens: number;
  requestedBytes: number;
  decoderChunks: number;
  sourceWrites: number;
  rolloutWatches: number;
  sqlRows: number;
  nativeSqlRows: number;
  nativeSqlPayloadBytes: number;
  sessions: number;
  sourceReadBytes: number;
  decodedWorkBytes: number;
  nativeOwnershipPrepares: number;
  nativeOwnershipRuns: number;
  nativeOwnershipTransactionalRuns: number;
  nativeOwnershipRunMs: number;
  metrics: {
    processVersion: string;
    memory: { rss: number; heapUsed: number; external: number; arrayBuffers: number };
    memoryPeak: { rss: number; heapUsed: number; external: number; arrayBuffers: number };
    eventLoopMaxMs: number;
    eventLoopP95Ms: number;
  };
}
const snapshot = () =>
  $fetch<Snapshot>("/api/__fixture/control", { method: "POST", body: { action: "snapshot" } });
const control = (action: "reset" | "close", fixtureRoot?: string) =>
  $fetch("/api/__fixture/control", {
    method: "POST",
    body: { action, ...(fixtureRoot ? { root: fixtureRoot } : {}) },
  });
const client = new LiveApiConversationRepository(async (path, options = {}) => {
  const response = await fetch(url(path), {
    signal: options.signal,
    method: options.method,
    headers: { "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
});
interface MetadataOwner {
  id: string;
  abort: AbortController;
  finish?: () => Promise<void>;
}
const metadataOwners = new Map<string, MetadataOwner>();
let currentTaskId = "";
let currentTaskSignal: AbortSignal;
beforeEach(({ task, signal }) => {
  currentTaskId = task.id;
  currentTaskSignal = signal;
});
function metadataOwner(id: string, signal: AbortSignal): MetadataOwner {
  const owner = { id, abort: new AbortController() };
  signal.addEventListener("abort", () => owner.abort.abort(signal.reason), { once: true });
  if (signal.aborted) {
    owner.abort.abort(signal.reason);
  }
  return owner;
}
const ownedControl = (
  owner: MetadataOwner,
  action: "reset" | "snapshot" | "deferred-scan",
  fixtureRoot?: string,
) => {
  owner.abort.signal.throwIfAborted();
  return $fetch<Snapshot>("/api/__fixture/control", {
    method: "POST",
    signal: owner.abort.signal,
    body: { action, owner: owner.id, ...(fixtureRoot ? { root: fixtureRoot } : {}) },
  });
};
async function observeQuiet(owner: MetadataOwner) {
  const before = await ownedControl(owner, "snapshot");
  expect(before.runtimeOwner).toBe(owner.id);
  // Cross an actual reconciliation interval, with the same runtime still open
  await new Promise<void>((done, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(owner.abort.signal.reason);
    };
    const timer = setTimeout(() => {
      owner.abort.signal.removeEventListener("abort", abort);
      done();
    }, 1200);
    owner.abort.signal.addEventListener("abort", abort, { once: true });
  });
  const observed = await ownedControl(owner, "snapshot");
  expect(observed.runtimeOwner).toBe(owner.id);
  expect(observed).toMatchObject({
    fullReads: 0,
    rolloutIo: 0,
    rolloutOpens: 0,
    decoderChunks: 0,
    sessions: 0,
    sourceWrites: 0,
    rolloutWatches: 0,
  });
  return observed;
}
afterEach(async ({ task }) => {
  const owner = metadataOwners.get(task.id);
  if (!owner) {
    await control("close");
    return;
  }
  try {
    await owner.finish?.();
  } finally {
    owner.abort.abort(new Error("Metadata case lifecycle ended"));
    metadataOwners.delete(task.id);
    await $fetch("/api/__fixture/control", {
      method: "POST",
      body: { action: "close", owner: owner.id },
    });
  }
});
afterAll(async () => {
  const receipt = {
    version: 1,
    profilingEnabled: Boolean(process.env["VIEWER_PROFILE_OUTPUT"]),
    conditions:
      "Production Nitro fixture routes, real LiveViewerRuntime and materializer, private fresh derivative caches, OS page cache uncontrolled, repetitions are descriptive observations",
    observations,
  };
  console.log(JSON.stringify(receipt));
  if (process.env["VIEWER_METRICS_OUTPUT"]) {
    await writeFile(
      resolve(process.env["VIEWER_METRICS_OUTPUT"]),
      JSON.stringify(receipt, null, 2),
    );
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function measure<T>(condition: string, repetition: number, operation: () => Promise<T>) {
  const before = await snapshot();
  const started = performance.now();
  const value = await operation();
  const durationMs = performance.now() - started;
  const after = await snapshot();
  observations.push({
    condition,
    repetition,
    durationMs,
    sourceReadBytes: after.sourceReadBytes - before.sourceReadBytes,
    decodedWorkBytes: after.decodedWorkBytes - before.decodedWorkBytes,
    requestedBytes: after.requestedBytes - before.requestedBytes,
    decoderChunks: after.decoderChunks - before.decoderChunks,
    fullReads: after.fullReads - before.fullReads,
    sqlRows: after.sqlRows - before.sqlRows,
    nativeSqlRows: after.nativeSqlRows - before.nativeSqlRows,
    nativeSqlPayloadBytes: after.nativeSqlPayloadBytes - before.nativeSqlPayloadBytes,
    metrics: after.metrics,
    sourceWrites: after.sourceWrites,
  });
  expect(after.sourceWrites).toBe(0);
  return value;
}
async function sessionFixture(compressed: boolean, turns = 30) {
  const fixtureRoot = await mkdtemp(join(root, "case-"));
  const home = join(fixtureRoot, "home");
  await mkdir(join(home, "sessions"), { recursive: true });
  const records = Array.from({ length: turns }, (_, index) =>
    canonicalRecords(`answer ${index}`)
      .slice(index === 0 ? 0 : 1)
      .map(
        (record) =>
          JSON.parse(
            JSON.stringify(record)
              .replaceAll('"stable"', '"thread-1"')
              .replaceAll('"turn"', `"turn-${index}"`)
              .replaceAll('"user"', `"user-${index}"`)
              .replaceAll('"answer"', `"answer-${index}"`),
          ) as unknown,
      ),
  ).flat();
  const raw = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const path = join(home, `sessions/rollout-thread-1.jsonl${compressed ? ".zst" : ""}`);
  await writeFile(path, compressed ? zstdCompressSync(Buffer.from(raw)) : raw);
  const state = createStateDatabase(join(home, "state_5.sqlite"));
  state
    .prepare("UPDATE threads SET rollout_path = ?, thread_section_id = NULL")
    .run(`sessions/rollout-thread-1.jsonl${compressed ? ".zst" : ""}`);
  state.close();
  return { root: fixtureRoot, home, path, raw };
}

it.each([1, 2, 3, 4, 5])(
  "production metadata readiness repetition %i observes zero transcript work for 3000 paths",
  async (repetition) => {
    const owner = metadataOwner(currentTaskId, currentTaskSignal);
    metadataOwners.set(owner.id, owner);
    const selectedClient = new LiveApiConversationRepository(async (path, options = {}) => {
      owner.abort.signal.throwIfAborted();
      const response = await fetch(url(path), {
        signal: options.signal
          ? AbortSignal.any([options.signal, owner.abort.signal])
          : owner.abort.signal,
        method: options.method,
        headers: { "content-type": "application/json", "x-viewer-fixture-owner": owner.id },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      owner.abort.signal.throwIfAborted();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      return response.json();
    });
    const stages: Record<string, number> = {};
    observations.push({ condition: "metadata-stage-costs", repetition, stages });
    const fixtureStarted = performance.now();
    const f = await sessionFixture(false);
    const heavy = await open(join(f.home, "sessions/heavy-unread.jsonl.zst"), "w");
    await heavy.truncate(64 * 1024 * 1024);
    await heavy.close();
    const database = new DatabaseSync(join(f.home, "state_5.sqlite"));
    database.exec(
      "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT); INSERT INTO projects VALUES ('none','Native none'); ALTER TABLE threads ADD COLUMN project_id TEXT",
    );
    const seed = database.prepare("SELECT * FROM threads LIMIT 1").get()!;
    database.exec(
      "DELETE FROM threads; DELETE FROM thread_spawn_edges; DELETE FROM thread_sections; BEGIN",
    );
    const keys = Object.keys(seed);
    const insert = database.prepare(
      `INSERT INTO threads (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    );
    for (let index = 0; index < 3000; index += 1) {
      const row = {
        ...seed,
        id: `metadata-${index}`,
        name: `Metadata ${index}`,
        rollout_path: `sessions/inaccessible/${index}.jsonl.zst`,
        archived: index % 3 === 0 ? 1 : 0,
        project_id: index % 2 === 0 ? "none" : null,
      };
      insert.run(...keys.map((key) => row[key as keyof typeof row]));
    }
    database.exec("COMMIT");
    database.close();
    stages["fixtureMs"] = performance.now() - fixtureStarted;
    if (process.env["VIEWER_PROFILE_OUTPUT"]) {
      await $fetch("/api/__fixture/control", { method: "POST", body: { action: "profile-start" } });
    }
    const started = performance.now();
    await ownedControl(owner, "reset", f.root);
    stages["runtimeResetMs"] = performance.now() - started;
    const firstStarted = performance.now();
    const first = await selectedClient.listSessions({ scope: "active", limit: 20 });
    stages["firstResponseMs"] = performance.now() - firstStarted;
    const durationMs = performance.now() - started;
    expect(first.total).toBe(2000);
    const groupsStarted = performance.now();
    const groups = await selectedClient.listProjects();
    stages["groupsMs"] = performance.now() - groupsStarted;
    expect(groups.map((group) => group.groupId)).toEqual(
      expect.arrayContaining(["project:none", "recents:none"]),
    );
    const browsingStarted = performance.now();
    for (const group of groups) {
      // oxlint-disable-next-line no-await-in-loop -- Simulate sequential ordinary group browsing before the quiet interval
      await selectedClient.listSessions({ scope: "active", groupId: group.groupId, limit: 20 });
      // oxlint-disable-next-line no-await-in-loop -- Scope switching reuses the same real running viewer
      await selectedClient.listSessions({ scope: "archived", groupId: group.groupId, limit: 20 });
    }
    await selectedClient.listSessions({ scope: "active", query: "Metadata 12" });
    stages["browsingAndTitleSearchMs"] = performance.now() - browsingStarted;
    if (process.env["VIEWER_PROFILE_OUTPUT"]) {
      const profile = await $fetch("/api/__fixture/control", {
        method: "POST",
        body: { action: "profile-stop" },
      });
      await writeFile(resolve(process.env["VIEWER_PROFILE_OUTPUT"]), JSON.stringify(profile));
    }
    owner.abort.signal.throwIfAborted();
    if (process.env["VIEWER_DEFERRED_SCAN_NEGATIVE"] === "1") {
      await ownedControl(owner, "deferred-scan");
    }
    owner.finish = async () => {
      const observed = await observeQuiet(owner);
      stages["totalObservedMs"] = performance.now() - fixtureStarted;
      observations.push({
        condition: "metadata-ready-3000-fresh-viewer-cache",
        repetition,
        durationMs,
        metadataRows: 3000,
        heavyUnopenedBytes: 64 * 1024 * 1024,
        fullReads: observed.fullReads,
        rolloutIo: observed.rolloutIo,
        rolloutOpens: observed.rolloutOpens,
        decoderChunks: observed.decoderChunks,
        sourceWrites: observed.sourceWrites,
        sourceReadBytes: observed.sourceReadBytes,
        decodedWorkBytes: observed.decodedWorkBytes,
        rolloutWatches: observed.rolloutWatches,
        sqlRows: observed.sqlRows,
        cacheOwnership: {
          prepares: observed.nativeOwnershipPrepares,
          runs: observed.nativeOwnershipRuns,
          transactionalRuns: observed.nativeOwnershipTransactionalRuns,
          runMs: observed.nativeOwnershipRunMs,
        },
        metrics: observed.metrics,
      });
    };
  },
);

it("the same quiet guard rejects a real deferred source scan", async ({ task, signal }) => {
  const owner = metadataOwner(task.id, signal);
  metadataOwners.set(task.id, owner);
  const f = await sessionFixture(false);
  await ownedControl(owner, "reset", f.root);
  await client.listSessions({ scope: "active", limit: 20 });
  expect((await ownedControl(owner, "snapshot")).rolloutIo).toBe(0);
  await ownedControl(owner, "deferred-scan");
  await expect(observeQuiet(owner)).rejects.toThrow(/to match object/u);
  expect((await ownedControl(owner, "snapshot")).rolloutIo).toBeGreaterThan(0);
});

it("cancelled owners cannot reset, observe or close the next case runtime", async ({
  task,
  signal,
}) => {
  const oldOwner = metadataOwner(task.id, signal);
  metadataOwners.set(task.id, oldOwner);
  const f = await sessionFixture(false);
  await ownedControl(oldOwner, "reset", f.root);
  await ownedControl(oldOwner, "deferred-scan");
  await $fetch("/api/__fixture/control", {
    method: "POST",
    body: { action: "close", owner: oldOwner.id },
  });
  const current = metadataOwner(`${task.id}:next`, signal);
  metadataOwners.set(task.id, current);
  await ownedControl(current, "reset", f.root);
  await expect(ownedControl(oldOwner, "reset", f.root)).rejects.toThrow(/500/u);
  await expect(ownedControl(oldOwner, "snapshot")).rejects.toThrow(/500/u);
  await $fetch("/api/__fixture/control", {
    method: "POST",
    body: { action: "close", owner: oldOwner.id },
  });
  const observed = await observeQuiet(current);
  expect(observed.runtimeOwner).toBe(current.id);
  oldOwner.abort.abort(new Error("Cancelled test owner"));
  expect(() => ownedControl(oldOwner, "snapshot")).toThrow("Cancelled test owner");
});

it.each([1, 2, 3, 4, 5])(
  "production plain, older and append paths repetition %i",
  async (repetition) => {
    const f = await sessionFixture(false, 200);
    await control("reset", f.root);
    const first = await measure("plain-latest-fresh-viewer-cache", repetition, () =>
      client.getHistoryPage("thread-1", { anchor: { kind: "latest" }, limit: 5 }),
    );
    expect(first.turns).toHaveLength(5);
    expect((await snapshot()).rolloutIo).toBeGreaterThan(0);
    expect((await snapshot()).sourceReadBytes).toBeGreaterThan(0);
    expect(first.beforeCursor).not.toBeNull();
    await measure("plain-older-after-latest", repetition, () =>
      client.getHistoryPage("thread-1", {
        anchor: { kind: "before", cursor: first.beforeCursor! },
        limit: 5,
      }),
    );
    const appended =
      canonicalRecords("new live answer")
        .slice(1)
        .map((record) => JSON.stringify(record).replaceAll('"turn"', '"live-turn"'))
        .join("\n") + "\n";
    await appendFile(f.path, appended);
    const latest = await measure("plain-live-append", repetition, () =>
      client.getHistoryPage("thread-1", { anchor: { kind: "latest" }, limit: 5 }),
    );
    expect(JSON.stringify(latest)).toContain("new live answer");
    expect((await snapshot()).fullReads).toBe(0);
  },
);

it.each([1, 2, 3, 4, 5])(
  "production compressed cold, validated warm and stopped-viewer replacement repetition %i",
  async (repetition) => {
    const f = await sessionFixture(true, 200);
    await control("reset", f.root);
    await measure("zstd-latest-fresh-viewer-cache", repetition, () =>
      client.getHistoryPage("thread-1", { anchor: { kind: "latest" }, limit: 5 }),
    );
    const before = await snapshot();
    await measure("zstd-latest-validated-warm", repetition, () =>
      client.getHistoryPage("thread-1", { anchor: { kind: "latest" }, limit: 5 }),
    );
    expect((await snapshot()).decoderChunks).toBe(before.decoderChunks);
    await control("close");
    await writeFile(
      f.path,
      zstdCompressSync(Buffer.from(f.raw.replaceAll("answer 199", "replaced B"))),
    );
    await control("reset", f.root);
    const changed = await measure(
      "zstd-recompression-restarted-viewer-existing-cache",
      repetition,
      () => client.getHistoryPage("thread-1", { anchor: { kind: "latest" }, limit: 5 }),
    );
    expect(JSON.stringify(changed)).toContain("replaced B");
    expect(JSON.stringify(changed)).not.toContain("answer 199");
    observations.push({
      condition: "zstd-input-sizes",
      repetition,
      encodedBytes: (await readFile(f.path)).length,
      decodedBytes: Buffer.byteLength(f.raw),
    });
  },
);

it.each([1, 2, 3, 4, 5])(
  "production native selected range with background snapshot repetition %i",
  async (repetition) => {
    const f = await sessionFixture(false, 1);
    const database = new DatabaseSync(join(f.home, "thread_history_1.sqlite"));
    database.exec(HISTORY_FIXTURE_SCHEMA);
    database.exec(
      "CREATE TABLE unrelated_history_payload (value BLOB); INSERT INTO unrelated_history_payload VALUES (zeroblob(33554432))",
    );
    addTurn(database, "thread-1", "turn-0");
    database.exec(
      "UPDATE thread_turns SET first_user_item_id = 'user-0', final_agent_item_id = 'answer-0'",
    );
    addItem(
      database,
      "user-0",
      2,
      {
        type: "userMessage",
        id: "user-0",
        clientId: null,
        content: [{ type: "text", text: "question" }],
      },
      "thread-1",
      "turn-0",
    );
    addItem(
      database,
      "answer-0",
      3,
      { type: "agentMessage", id: "answer-0", text: "answer 0", phase: "final_answer" },
      "thread-1",
      "turn-0",
    );
    database
      .prepare("INSERT INTO thread_history_projection_state VALUES(?,?,?)")
      .run("thread-1", Buffer.byteLength(f.raw), 5);
    database.close();
    await control("reset", f.root);
    const first = await measure(
      "native-source-first-selected-background-snapshot",
      repetition,
      () => client.getHistoryPage("thread-1", { anchor: { kind: "latest" } }),
    );
    expect(first.turns).toHaveLength(1);
    await vi.waitFor(async () =>
      expect(
        await readFile(join(f.root, "cache/history-snapshots/current.json"), "utf8"),
      ).toContain("generationId"),
    );
    expect((await snapshot()).nativeSqlRows).toBe(0);
    const native = await measure("native-first-timed-page-after-snapshot-ready", repetition, () =>
      client.getHistoryPage("thread-1", { anchor: { kind: "latest" } }),
    );
    expect(native.turns).toHaveLength(1);
    expect((await snapshot()).nativeSqlPayloadBytes).toBeGreaterThan(0);
  },
);
