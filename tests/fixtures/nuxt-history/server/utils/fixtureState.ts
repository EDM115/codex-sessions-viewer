import fixtureNodeFs, { promises as fixtureFs } from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import type { CachedContentFile } from "#server/cache/contentStore.ts";
import { readStableJsonl } from "#server/ingestion/jsonlStream.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import { RolloutFramingValidator } from "#server/ingestion/zstdRollout.ts";
import { LiveViewerRuntime } from "#server/live/viewerRuntime.ts";

let runtime: LiveViewerRuntime | null = null;
let runtimeOwner: string | null = null;
let runtimeGeneration = 0;
let deferredScan: ReturnType<typeof setTimeout> | undefined;
const cancelledOwners = new Set<string>();
export function assertFixtureOwner(owner: string) {
  if (runtimeOwner !== owner || cancelledOwners.has(owner)) {
    throw new Error("Fixture runtime owner is stale or cancelled");
  }
}
export function deferFixtureScan(owner: string) {
  assertFixtureOwner(owner);
  const selected = runtime;
  deferredScan = setTimeout(() => {
    if (runtime === selected && runtimeOwner === owner && !cancelledOwners.has(owner)) {
      // Actual source enumeration is the negative control for the quiet-period guard
      void fixtureFs.readdir(join(selected!.settings.codexHome, "sessions"));
    }
  }, 50);
}
const fixtureStartupCwd = process.cwd();
let cpuProfile: Session | null = null;
export async function fixtureCpuProfile(action: "start" | "stop") {
  if (action === "start") {
    cpuProfile?.disconnect();
    cpuProfile = new Session();
    cpuProfile.connect();
    await cpuProfile.post("Profiler.enable");
    await cpuProfile.post("Profiler.start");
    return { started: true };
  }
  if (!cpuProfile) {
    throw new Error("Fixture CPU profile was not started");
  }
  const session = cpuProfile;
  cpuProfile = null;
  try {
    return (await session.post("Profiler.stop")).profile;
  } finally {
    session.disconnect();
  }
}
let gate: {
  entered: boolean;
  aborted: boolean;
  release: () => void;
  promise: Promise<void>;
} | null = null;
const counters = {
  fullReads: 0,
  rolloutOpens: 0,
  rolloutIo: 0,
  requestedBytes: 0,
  abortedOpens: 0,
  decoderChunks: 0,
  sourceWrites: 0,
  rolloutWatches: 0,
  sqlRows: 0,
  nativeSqlRows: 0,
  nativeSqlPayloadBytes: 0,
  sourceReadBytes: 0,
  decodedWorkBytes: 0,
  nativeOwnershipPrepares: 0,
  nativeOwnershipRuns: 0,
  nativeOwnershipTransactionalRuns: 0,
  nativeOwnershipRunMs: 0,
};
const events: unknown[] = [];
let content: { root: string; file: CachedContentFile | null } | null = null;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();
let memoryPeak = process.memoryUsage();
const memorySampler = setInterval(() => {
  const current = process.memoryUsage();
  for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const) {
    memoryPeak[key] = Math.max(memoryPeak[key], current[key]);
  }
}, 10);
memorySampler.unref();
function assertFixtureRoot(root: string) {
  const parent = process.env["VIEWER_TEST_ROOT"];
  const location = parent ? relative(resolve(parent), resolve(root)) : "..";
  if (!parent || isAbsolute(location) || location.startsWith("..")) {
    throw new Error("Fixture root escaped its temporary workspace");
  }
}
export function fixtureContent(value?: { root: string; file: CachedContentFile | null }) {
  if (value) {
    assertFixtureRoot(value.root);
    content = value;
  }
  return content;
}

export function activeFixtureRuntime() {
  return runtime;
}
export async function closeFixtureRuntime(owner?: string) {
  if (owner) {
    cancelledOwners.add(owner);
    if (runtimeOwner !== owner) {
      return;
    }
  }
  runtimeGeneration += 1;
  clearTimeout(deferredScan);
  fixtureGate(false);
  const selected = runtime;
  runtime = null;
  runtimeOwner = null;
  await selected?.close();
  if (process.env["VIEWER_TEST_CHDIR"] === "1") {
    process.chdir(fixtureStartupCwd);
  }
}
export function fixtureSnapshot() {
  return {
    runtimeOwner,
    ...counters,
    gate: gate && { entered: gate.entered, aborted: gate.aborted },
    status: runtime?.status,
    sessions:
      runtime?.database.prepare("SELECT count(*) AS count FROM sessions").get()?.["count"] ?? 0,
    authority: runtime?.database.prepare("SELECT * FROM history_semantic_epochs").all() ?? [],
    listeners: runtime?.bus.listenerCount ?? 0,
    events,
    metrics: {
      processVersion: process.version,
      cwd: process.cwd(),
      runtimeModuleUrl: import.meta.url,
      memory: process.memoryUsage(),
      memoryPeak,
      eventLoopMaxMs: eventLoopDelay.max / 1e6,
      eventLoopP95Ms: eventLoopDelay.percentile(95) / 1e6,
      observedAt: performance.now(),
    },
  };
}
export function fixtureGate(enabled: boolean) {
  gate?.release();
  gate = null;
  if (enabled) {
    let release!: () => void;
    const promise = new Promise<void>((settle) => {
      release = settle;
    });
    gate = { entered: false, aborted: false, release, promise };
  }
}
export async function resetFixture(root: string, owner?: string) {
  assertFixtureRoot(root);
  if (owner && cancelledOwners.has(owner)) {
    throw new Error("Fixture runtime owner was already cancelled");
  }
  await closeFixtureRuntime();
  if (owner && cancelledOwners.has(owner)) {
    throw new Error("Fixture runtime initialization was cancelled");
  }
  const generation = ++runtimeGeneration;
  runtimeOwner = owner ?? null;
  if (process.env["VIEWER_TEST_CHDIR"] === "1") {
    process.chdir(root);
  }
  fixtureGate(false);
  Object.assign(counters, {
    fullReads: 0,
    rolloutOpens: 0,
    rolloutIo: 0,
    requestedBytes: 0,
    abortedOpens: 0,
    decoderChunks: 0,
    sourceWrites: 0,
    rolloutWatches: 0,
    sqlRows: 0,
    nativeSqlRows: 0,
    nativeSqlPayloadBytes: 0,
    sourceReadBytes: 0,
    decodedWorkBytes: 0,
    nativeOwnershipPrepares: 0,
    nativeOwnershipRuns: 0,
    nativeOwnershipTransactionalRuns: 0,
    nativeOwnershipRunMs: 0,
  });
  events.length = 0;
  eventLoopDelay.reset();
  memoryPeak = process.memoryUsage();
  const cacheDir = join(root, "cache");
  const selected = await LiveViewerRuntime.start(
    {
      settings: { codexHome: join(root, "home"), port: 3000, fetchFavicons: false },
      paths: {
        cacheDir,
        configDir: join(root, "config"),
        configFile: join(root, "config/config.json"),
        generatedDir: join(cacheDir, "generated"),
        cacheDatabase: join(cacheDir, "viewer.sqlite"),
      },
      codexHomeSource: "cli",
      onboardingRequired: false,
      diagnostics: [],
    },
    {
      initialReconciliation: "deferred",
      reconciliationIntervalMs: 1000,
      debounceMs: 0,
      readJsonl: async (...args) => {
        counters.fullReads += 1;
        return readStableJsonl(...args);
      },
    },
  );
  if (generation !== runtimeGeneration || (owner && cancelledOwners.has(owner))) {
    await selected.close();
    throw new Error("Fixture runtime initialization was cancelled");
  }
  runtime = selected;
  runtime.bus.subscribe((event) => events.push(event));
  return fixtureSnapshot();
}
export function instrumentFixtureReads() {
  const descriptors = new Map<string, PropertyDescriptor>();
  const writing = [
    "writeFile",
    "appendFile",
    "rm",
    "rename",
    "unlink",
    "mkdir",
    "truncate",
    "link",
    "symlink",
    "copyFile",
  ];
  for (const name of ["open", "readFile", "opendir", "readdir", "stat", "lstat", ...writing]) {
    const descriptor = Object.getOwnPropertyDescriptor(fixtureFs, name);
    const original: unknown = descriptor?.value;
    if (!descriptor || typeof original !== "function") {
      continue;
    }
    descriptors.set(name, descriptor);
    Object.defineProperty(fixtureFs, name, {
      ...descriptor,
      value: (...args: unknown[]) => {
        const path = String(args[0]);
        const parent = process.env["VIEWER_TEST_ROOT"];
        if (
          parent &&
          path.toLowerCase().startsWith(parent.toLowerCase()) &&
          /[\\/](?:sessions|archived_sessions)(?:[\\/]|$)/u.test(path)
        ) {
          counters.rolloutIo += 1;
        }
        if (
          parent &&
          path.toLowerCase().startsWith(parent.toLowerCase()) &&
          /[\\/]home(?:[\\/]|$)/u.test(path) &&
          (writing.includes(name) ||
            (name === "open" && typeof args[1] === "string" && /[wa+]/u.test(args[1])))
        ) {
          counters.sourceWrites += 1;
        }
        const result: unknown = Reflect.apply(original, fixtureFs, args);
        const source =
          parent &&
          path.toLowerCase().startsWith(parent.toLowerCase()) &&
          /[\\/](?:sessions|archived_sessions)(?:[\\/]|$)/u.test(path);
        if (source && name === "open") {
          return Promise.resolve(result).then((handle: unknown) => {
            if (
              typeof handle === "object" &&
              handle !== null &&
              "read" in handle &&
              typeof handle.read === "function"
            ) {
              const read = handle.read;
              Object.defineProperty(handle, "read", {
                value: async (...parameters: unknown[]) => {
                  const value: unknown = await Reflect.apply(read, handle, parameters);
                  if (
                    typeof value === "object" &&
                    value !== null &&
                    "bytesRead" in value &&
                    typeof value.bytesRead === "number"
                  ) {
                    counters.sourceReadBytes += value.bytesRead;
                  }
                  return value;
                },
              });
            }
            return handle;
          });
        }
        if (source && name === "readFile") {
          return Promise.resolve(result).then((value: unknown) => {
            if (typeof value === "string" || Buffer.isBuffer(value)) {
              counters.sourceReadBytes += Buffer.byteLength(value);
            }
            return value;
          });
        }
        return result;
      },
    });
  }
  const watch = fixtureNodeFs.watch;
  const createReadStream = fixtureNodeFs.createReadStream;
  fixtureNodeFs.createReadStream = function (...args) {
    const stream = createReadStream(...args);
    if (/[\\/](?:sessions|archived_sessions)(?:[\\/]|$)/u.test(String(args[0]))) {
      counters.rolloutIo += 1;
      stream.once("close", () => {
        counters.sourceReadBytes += stream.bytesRead;
      });
    }
    return stream;
  };
  fixtureNodeFs.watch = function (...args: Parameters<typeof watch>) {
    if (/[\\/](?:sessions|archived_sessions)(?:[\\/]|$)/u.test(String(args[0]))) {
      counters.rolloutWatches += 1;
    }
    return Reflect.apply(watch, fixtureNodeFs, args);
  } as typeof watch;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (/^\s*INSERT INTO catalog_native_ownership\b/iu.test(sql)) {
      counters.nativeOwnershipPrepares += 1;
      const run = statement.run.bind(statement);
      Object.defineProperty(statement, "run", {
        value: (...args: Parameters<typeof run>) => {
          counters.nativeOwnershipRuns += 1;
          if (this.isTransaction) {
            counters.nativeOwnershipTransactionalRuns += 1;
          }
          const started = performance.now();
          try {
            return run(...args);
          } finally {
            counters.nativeOwnershipRunMs += performance.now() - started;
          }
        },
      });
    }
    const native = /\b(?:thread_items|thread_turns|thread_history_projection_state)\b/iu.test(sql);
    const count = (rows: unknown[]) => {
      counters.sqlRows += rows.length;
      if (native) {
        counters.nativeSqlRows += rows.length;
        for (const row of rows) {
          if (
            typeof row === "object" &&
            row !== null &&
            "item_json" in row &&
            typeof row.item_json === "string"
          ) {
            counters.nativeSqlPayloadBytes += Buffer.byteLength(row.item_json);
          }
        }
      }
    };
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    Object.defineProperty(statement, "all", {
      value: (...args: Parameters<typeof all>) => {
        const rows = all(...args);
        count(rows);
        return rows;
      },
    });
    Object.defineProperty(statement, "get", {
      value: (...args: Parameters<typeof get>) => {
        const row = get(...args);
        count(row === undefined ? [] : [row]);
        return row;
      },
    });
    return statement;
  };
  syncBuiltinESMExports();
  // oxlint-disable-next-line typescript/unbound-method -- The instrumentation forwards the original receiver with call below
  const open = RolloutStore.prototype.open;
  // oxlint-disable-next-line typescript/unbound-method -- The instrumentation forwards the original receiver with call below
  const write = RolloutFramingValidator.prototype.write;
  RolloutFramingValidator.prototype.write = function (chunk) {
    counters.decoderChunks += 1;
    counters.decodedWorkBytes += chunk.byteLength;
    return write.call(this, chunk);
  };
  RolloutStore.prototype.open = async function (ref, signal) {
    counters.rolloutOpens += 1;
    const aborted = () => {
      counters.abortedOpens += 1;
    };
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      const lease = await open.call(this, ref, signal);
      return {
        ...lease,
        read: async (start, end, readSignal) => {
          counters.requestedBytes += end - start;
          const current = gate;
          if (current) {
            current.entered = true;
            await new Promise<void>((settle, reject) => {
              const abort = () => {
                current.aborted = true;
                reject(readSignal?.reason);
              };
              if (readSignal?.aborted) {
                abort();
                return;
              }
              readSignal?.addEventListener("abort", abort, { once: true });
              void current.promise.then(() => {
                readSignal?.removeEventListener("abort", abort);
                settle();
                return undefined;
              });
            });
          }
          return lease.read(start, end, readSignal);
        },
      };
    } finally {
      signal?.removeEventListener("abort", aborted);
    }
  };
  return async () => {
    cpuProfile?.disconnect();
    cpuProfile = null;
    clearInterval(memorySampler);
    eventLoopDelay.disable();
    fixtureGate(false);
    await runtime?.close();
    runtime = null;
    RolloutStore.prototype.open = open;
    RolloutFramingValidator.prototype.write = write;
    DatabaseSync.prototype.prepare = prepare;
    fixtureNodeFs.watch = watch;
    fixtureNodeFs.createReadStream = createReadStream;
    for (const [name, descriptor] of descriptors) {
      Object.defineProperty(fixtureFs, name, descriptor);
    }
    syncBuiltinESMExports();
  };
}
