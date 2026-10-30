import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { setup, $fetch } from "@nuxt/test-utils/e2e";
import { afterAll, afterEach, expect, it } from "vitest";

import {
  addItem,
  addTurn,
  canonicalRecords,
  HISTORY_FIXTURE_SCHEMA,
} from "../fixtures/history/nativeHistory.ts";
import { createStateDatabase } from "../integration/source-boundary/fixtures.ts";

// Opt-in physical multi-GiB observation, ordinary HTTP tests retain their existing limits
const enabled = process.env["VIEWER_LARGE_NATIVE"] === "1";
const observations: unknown[] = [];
let root = "";
if (enabled) {
  root = await mkdtemp(join(tmpdir(), "viewer-native-large-"));
  await setup({
    rootDir: resolve("tests/fixtures/nuxt-history"),
    dev: false,
    env: { VIEWER_TEST_ROOT: root, VIEWER_TEST_CHDIR: "1" },
    setupTimeout: 240000,
  });
}
afterEach(async () => {
  if (enabled) {
    await $fetch("/api/__fixture/control", { method: "POST", body: { action: "close" } });
  }
});
afterAll(async () => {
  if (!enabled) {
    return;
  }
  const output = process.env["VIEWER_METRICS_OUTPUT"];
  if (output) {
    await writeFile(
      resolve(output),
      JSON.stringify(
        {
          conditions:
            "Actual production Nitro routes and background snapshot worker, 65 allocated 32-MiB SQLite BLOBs, fresh viewer cache per repetition, OS page cache uncontrolled",
          observations,
        },
        null,
        2,
      ),
    );
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it.skipIf(!enabled).each([1, 2, 3, 4, 5])(
  "multi-GiB native worker and HTTP responsiveness repetition %i",
  async (repetition) => {
    const fixture = join(root, `case-${repetition}`);
    const home = join(fixture, "home");
    await mkdir(join(home, "sessions"), { recursive: true });
    const raw =
      canonicalRecords()
        .map((record) => JSON.stringify(record).replaceAll('"stable"', '"thread-1"'))
        .join("\n") + "\n";
    const source = join(home, "thread_history_1.sqlite");
    await writeFile(join(home, "sessions/rollout-thread-1.jsonl"), raw);
    const state = createStateDatabase(join(home, "state_5.sqlite"));
    state
      .prepare("UPDATE threads SET rollout_path = ?, thread_section_id = NULL")
      .run("sessions/rollout-thread-1.jsonl");
    state.close();
    const database = new DatabaseSync(source);
    database.exec(HISTORY_FIXTURE_SCHEMA);
    database.exec("CREATE TABLE unrelated_payload (value BLOB); BEGIN");
    const insert = database.prepare("INSERT INTO unrelated_payload VALUES (zeroblob(33554432))");
    for (let index = 0; index < 65; index += 1) {
      insert.run();
    }
    database.exec("COMMIT");
    addTurn(database, "thread-1");
    addItem(
      database,
      "user",
      2,
      {
        type: "userMessage",
        id: "user",
        clientId: null,
        content: [{ type: "text", text: "question" }],
      },
      "thread-1",
    );
    addItem(
      database,
      "answer",
      3,
      { type: "agentMessage", id: "answer", text: "answer A", phase: "final_answer" },
      "thread-1",
    );
    database
      .prepare("INSERT INTO thread_history_projection_state VALUES(?,?,?)")
      .run("thread-1", Buffer.byteLength(raw), 5);
    const checked = database.prepare("PRAGMA quick_check").get();
    const pageCount = database.prepare("PRAGMA page_count").get();
    const pageSize = database.prepare("PRAGMA page_size").get();
    database.close();
    expect(checked?.["quick_check"]).toBe("ok");
    const before = await stat(source);
    expect(before.size).toBeGreaterThan(2 * 1024 ** 3);
    const allocation =
      process.platform === "win32"
        ? execFileSync(
            "fsutil.exe",
            ["file", "queryallocranges", "offset=0", `length=${before.size}`, source],
            { encoding: "utf8" },
          )
        : null;
    const allocationCoordinates =
      allocation?.match(/0x[\da-f]+/giu)?.map((value) => Number.parseInt(value.slice(2), 16)) ?? [];
    const allocatedBytes = allocationCoordinates
      .filter((_value, index) => index % 2 === 1)
      .reduce((sum, value) => sum + value, 0);
    if (process.platform === "win32") {
      expect(allocatedBytes).toBeGreaterThanOrEqual(before.size);
    }
    const started = performance.now();
    await $fetch("/api/__fixture/control", {
      method: "POST",
      body: { action: "reset", root: fixture },
    });
    const metadataStarted = performance.now();
    await $fetch("/api/sessions?scope=active&limit=20");
    const metadataMs = performance.now() - metadataStarted;
    const selectedStarted = performance.now();
    const first = await $fetch<{ turns: unknown[] }>("/api/sessions/thread-1/turns?anchor=latest");
    const firstPageMs = performance.now() - selectedStarted;
    expect(first.turns).toHaveLength(1);
    const responseMs: number[] = [];
    let manifest: { generationId: string; digest: string } | null = null;
    const snapshotStarted = performance.now();
    while (manifest === null && performance.now() - snapshotStarted < 90000) {
      const requestStarted = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- Sequential requests observe responsiveness during the actual background worker
      await $fetch("/api/sessions?scope=active&limit=20");
      responseMs.push(performance.now() - requestStarted);
      try {
        // oxlint-disable-next-line no-await-in-loop -- Poll the actual published worker manifest without replacing worker behavior
        const savedManifest = await readFile(
          join(fixture, "cache/history-snapshots/current.json"),
          "utf8",
        );
        manifest = JSON.parse(savedManifest);
      } catch {
        // oxlint-disable-next-line no-await-in-loop -- Fixed observation interval, not a product timeout adjustment
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    expect(manifest?.generationId).toBeTruthy();
    expect(responseMs.length).toBeGreaterThan(1);
    const nativeStarted = performance.now();
    await $fetch("/api/sessions/thread-1/turns?anchor=latest");
    const nativePageMs = performance.now() - nativeStarted;
    const counters = await $fetch<{
      sourceWrites: number;
      nativeSqlRows: number;
      nativeSqlPayloadBytes: number;
      metrics: { cwd: string; runtimeModuleUrl: string };
    }>("/api/__fixture/control", { method: "POST", body: { action: "snapshot" } });
    expect(counters.sourceWrites).toBe(0);
    expect(counters.nativeSqlPayloadBytes).toBeGreaterThan(0);
    expect(counters.metrics.cwd).toBe(fixture);
    expect(counters.metrics.runtimeModuleUrl).toMatch(/\/output\/server\/(?:index\.mjs|chunks\/)/u);
    const emitted = await readFile(fileURLToPath(counters.metrics.runtimeModuleUrl), "utf8");
    expect(emitted).toContain("./chunks/_/nitro.mjs");
    const workerChunkPath = join(
      dirname(fileURLToPath(counters.metrics.runtimeModuleUrl)),
      "chunks/_/nitro.mjs",
    );
    const workerChunk = await readFile(workerChunkPath, "utf8");
    expect(workerChunk).toContain("History source changed during copy");
    expect(workerChunk).toMatch(/eval:\s*true/u);
    expect(emitted).not.toMatch(/(?:from|import)\s*["'][^"']+\.ts["']/u);
    expect(workerChunk).not.toMatch(/(?:from|import)\s*["'][^"']+\.ts["']/u);
    const after = await stat(source);
    expect([after.size, after.mtimeMs, after.ctimeMs]).toEqual([
      before.size,
      before.mtimeMs,
      before.ctimeMs,
    ]);
    observations.push({
      repetition,
      logicalFileSize: before.size,
      physicalAllocatedBytes: allocatedBytes,
      allocationObservation: allocation,
      emittedRuntimeSha256: createHash("sha256").update(emitted).digest("hex"),
      workerChunkPath,
      workerChunkSha256: createHash("sha256").update(workerChunk).digest("hex"),
      workerPackaging:
        "Inline eval worker bundled in emitted runtime, Node builtins only, observed worker completion and native SQL while server cwd is private fixture",
      sqlitePageCount: pageCount,
      sqlitePageSize: pageSize,
      allocatedPayloadBytes: 65 * 33554432,
      sourceQuickCheck: checked,
      metadataMs,
      firstPageMs,
      nativePageMs,
      totalMs: performance.now() - started,
      responsiveRequestsDuringSnapshot: responseMs,
      manifest,
      sourceStatUnchanged: true,
      counters,
    });
    await $fetch("/api/__fixture/control", { method: "POST", body: { action: "close" } });
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  },
  120000,
);
