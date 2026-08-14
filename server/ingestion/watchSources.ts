import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { watch } from "chokidar";

import type { ConversationScope } from "../../shared/types/conversation.ts";

export type SourceChangeKind = "added" | "changed" | "removed";
export type MetadataSourceKind = "global-state" | "session-index" | "state-database" | "state-wal";

export interface RolloutSourceChange {
  kind: SourceChangeKind;
  path: string;
  source: "rollout";
  scope: ConversationScope;
}

export interface MetadataSourceChange {
  kind: SourceChangeKind;
  path: string;
  source: MetadataSourceKind;
}

export type SourceChange = RolloutSourceChange | MetadataSourceChange;

export interface SourceWatchBatch {
  changes: SourceChange[];
  observedAt: string;
}

export interface WatchSourcesOptions {
  codexHome: string;
  debounceMs?: number | undefined;
  onBatch: (batch: SourceWatchBatch) => Promise<void> | void;
  onError?: ((error: unknown) => void) | undefined;
}

export interface SourceWatcher {
  ready: Promise<void>;
  close(): Promise<void>;
}

interface WatchRoots {
  active: string;
  archived: string;
  metadata: Map<string, MetadataSourceKind>;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function rolloutChange(
  path: string,
  root: string,
  scope: ConversationScope,
  kind: SourceChangeKind,
): RolloutSourceChange | null {
  const resolvedPath = resolve(path);
  return isWithinRoot(root, resolvedPath) && resolvedPath.toLowerCase().endsWith(".jsonl")
    ? { kind, path: resolvedPath, source: "rollout", scope }
    : null;
}

function classifyChange(
  path: string,
  kind: SourceChangeKind,
  roots: WatchRoots,
): SourceChange | null {
  const resolvedPath = resolve(path);
  const metadataSource = roots.metadata.get(pathKey(resolvedPath));
  if (metadataSource !== undefined) {
    return { kind, path: resolvedPath, source: metadataSource };
  }

  return (
    rolloutChange(resolvedPath, roots.active, "active", kind) ??
    rolloutChange(resolvedPath, roots.archived, "archived", kind)
  );
}

function changeKind(event: string): SourceChangeKind | null {
  switch (event) {
    case "add":
      return "added";
    case "change":
      return "changed";
    case "unlink":
      return "removed";
    default:
      return null;
  }
}

export function watchSources(options: WatchSourcesOptions): SourceWatcher {
  const debounceMs = options.debounceMs ?? 100;
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) {
    throw new RangeError("debounceMs must be a non-negative safe integer");
  }

  const metadataSources: ReadonlyArray<readonly [string, MetadataSourceKind]> = [
    [join(options.codexHome, "session_index.jsonl"), "session-index"],
    [join(options.codexHome, ".codex-global-state.json"), "global-state"],
    [join(options.codexHome, "state_5.sqlite"), "state-database"],
    [join(options.codexHome, "state_5.sqlite-wal"), "state-wal"],
  ];
  const roots: WatchRoots = {
    active: resolve(options.codexHome, "sessions"),
    archived: resolve(options.codexHome, "archived_sessions"),
    metadata: new Map<string, MetadataSourceKind>(
      metadataSources.map(([path, kind]) => [pathKey(path), kind]),
    ),
  };
  const paths = [roots.active, roots.archived, ...roots.metadata.keys()];
  const pending = new Map<string, SourceChange>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  let flushChain = Promise.resolve();
  let closed = false;

  const watchers = paths.map((path) =>
    watch(path, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: false,
      atomic: true,
    }),
  );

  async function flush(keys: readonly string[]): Promise<void> {
    const changes = keys
      .map((key) => pending.get(key))
      .filter((change): change is SourceChange => change !== undefined)
      .toSorted((left, right) => left.path.localeCompare(right.path));
    for (const key of keys) {
      pending.delete(key);
    }
    if (changes.length === 0) {
      return;
    }
    try {
      await options.onBatch({ changes, observedAt: new Date().toISOString() });
    } catch (error) {
      options.onError?.(error);
    }
  }

  function enqueueFlush(keys: readonly string[]): Promise<void> {
    flushChain = flushChain.then(() => flush(keys));
    return flushChain;
  }

  function schedule(change: SourceChange): void {
    const key = pathKey(change.path);
    pending.set(key, change);
    const existingTimer = debounceTimers.get(key);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      void enqueueFlush([key]);
    }, debounceMs);
    debounceTimers.set(key, timer);
  }

  const ready = Promise.all(
    watchers.map(
      (watcher) =>
        new Promise<void>((resolveReady, rejectReady) => {
          let settled = false;
          watcher.once("ready", () => {
            settled = true;
            resolveReady();
          });
          watcher.on("error", (error) => {
            options.onError?.(error);
            if (!settled) {
              settled = true;
              rejectReady(error);
            }
          });
          watcher.on("all", (event, path) => {
            if (closed) {
              return;
            }
            const kind = changeKind(event);
            if (kind === null) {
              return;
            }
            const change = classifyChange(path, kind, roots);
            if (change !== null) {
              schedule(change);
            }
          });
        }),
    ),
  ).then(() => undefined);

  return {
    ready,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      await enqueueFlush([...pending.keys()]);
      await Promise.all(watchers.map((watcher) => watcher.close()));
    },
  };
}
