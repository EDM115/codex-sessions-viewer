import { promises as fixtureFs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { CachedContentFile } from "#server/cache/contentStore.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import { RolloutFramingValidator } from "#server/ingestion/zstdRollout.ts";
import { LiveViewerRuntime } from "#server/live/viewerRuntime.ts";

let runtime: LiveViewerRuntime | null = null;
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
};
const events: unknown[] = [];
let content: { root: string; file: CachedContentFile | null } | null = null;
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
export async function closeFixtureRuntime() {
  fixtureGate(false);
  await runtime?.close();
  runtime = null;
}
export function fixtureSnapshot() {
  return {
    ...counters,
    gate: gate && { entered: gate.entered, aborted: gate.aborted },
    status: runtime?.status,
    sessions:
      runtime?.database.prepare("SELECT count(*) AS count FROM sessions").get()?.["count"] ?? 0,
    authority: runtime?.database.prepare("SELECT * FROM history_semantic_epochs").all() ?? [],
    listeners: runtime?.bus.listenerCount ?? 0,
    events,
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
export async function resetFixture(root: string) {
  assertFixtureRoot(root);
  fixtureGate(false);
  await runtime?.close();
  Object.assign(counters, {
    fullReads: 0,
    rolloutOpens: 0,
    rolloutIo: 0,
    requestedBytes: 0,
    abortedOpens: 0,
    decoderChunks: 0,
  });
  events.length = 0;
  const cacheDir = join(root, "cache");
  runtime = await LiveViewerRuntime.start(
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
      readJsonl: async () => {
        counters.fullReads += 1;
        throw new Error("Forbidden whole-session materialization in history fixture");
      },
    },
  );
  runtime.bus.subscribe((event) => events.push(event));
  return fixtureSnapshot();
}
export function instrumentFixtureReads() {
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const name of ["open", "readFile", "opendir", "readdir", "stat", "lstat"]) {
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
        return Reflect.apply(original, fixtureFs, args);
      },
    });
  }
  syncBuiltinESMExports();
  // oxlint-disable-next-line typescript/unbound-method -- The instrumentation forwards the original receiver with call below
  const open = RolloutStore.prototype.open;
  // oxlint-disable-next-line typescript/unbound-method -- The instrumentation forwards the original receiver with call below
  const write = RolloutFramingValidator.prototype.write;
  RolloutFramingValidator.prototype.write = function (chunk) {
    counters.decoderChunks += 1;
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
    fixtureGate(false);
    await runtime?.close();
    runtime = null;
    RolloutStore.prototype.open = open;
    RolloutFramingValidator.prototype.write = write;
    for (const [name, descriptor] of descriptors) {
      Object.defineProperty(fixtureFs, name, descriptor);
    }
    syncBuiltinESMExports();
  };
}
