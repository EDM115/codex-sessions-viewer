import { randomUUID } from "node:crypto";
import { lstat, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import * as z from "zod";

import { HISTORY_SNAPSHOT_WORKER } from "./historySnapshotWorker.ts";

export interface HistorySnapshotOptions {
  sourceDatabase: string;
  sourceWal: string;
  snapshotRoot: string;
}
const snapshotSchema = z.strictObject({
  databasePath: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  generationId: z.uuid(),
  observation: z.string(),
  capabilities: z.strictObject({
    supported: z.literal(true),
    updatedAtOrdinal: z.boolean(),
    turnEndOrdinal: z.boolean(),
    itemLifecycle: z.boolean(),
  }),
});
export type HistorySnapshot = z.infer<typeof snapshotSchema>;
const resultSchema = z.strictObject({
  status: z.enum(["created", "retained", "unavailable"]),
  snapshot: snapshotSchema.nullable(),
  diagnostics: z.array(z.string()),
});
export type HistorySnapshotResult = z.infer<typeof resultSchema>;
export interface HistorySnapshotAcquisition {
  generationId?: string;
  publish?: boolean;
  retireKeep?: string[];
}
export interface HistorySnapshotLease {
  snapshot: HistorySnapshot;
  release(): void;
}

/** No source SQLite connection is made, all SQLite recovery and validation is worker-owned */
export function snapshotHistoryDatabase(
  options: HistorySnapshotOptions,
  signal?: AbortSignal,
  retainOnly = false,
  acquisition: HistorySnapshotAcquisition = {},
): Promise<HistorySnapshotResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(HISTORY_SNAPSHOT_WORKER, {
      eval: true,
      workerData: {
        options: {
          sourceDatabase: options.sourceDatabase,
          sourceWal: options.sourceWal,
          snapshotRoot: options.snapshotRoot,
        },
        retainOnly,
        ...acquisition,
      },
    });
    let settled = false;
    function finish(error: unknown, value?: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        const parsed = resultSchema.safeParse(value);
        if (parsed.success) {
          resolve(parsed.data);
        } else {
          reject(parsed.error);
        }
      }
    }
    function abort() {
      void worker.terminate().then(() => finish(signal?.reason ?? new Error("Snapshot cancelled")));
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: unknown) => {
      if (!signal?.aborted) {
        finish(null, value);
      }
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) {
        finish(
          signal?.aborted
            ? signal.reason
            : new Error(`History worker exited before publishing (${code})`),
        );
      }
    });
  });
}

/** A cheap owned-artifact fence, full retained validation runs only in the background worker */
export async function historySnapshotUnchanged(snapshot: HistorySnapshot): Promise<boolean> {
  try {
    const info = await lstat(snapshot.databasePath, { bigint: true });
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1n &&
      [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":") ===
        snapshot.observation
    );
  } catch {
    return false;
  }
}

export class HistorySnapshotManager {
  readonly #options: HistorySnapshotOptions;
  readonly #controller = new AbortController();
  readonly #acquire: typeof snapshotHistoryDatabase;
  readonly #leases = new Map<string, number>();
  #snapshot: HistorySnapshot | null = null;
  #pending: Promise<void> | null = null;
  #revision = 0;
  #dirty = true;
  #retainedChecked = false;
  #pendingGeneration: string | null = null;
  #retirement: Promise<void> | null = null;
  #retireAgain = false;
  constructor(
    options: HistorySnapshotOptions,
    acquire: typeof snapshotHistoryDatabase = snapshotHistoryDatabase,
  ) {
    this.#options = options;
    this.#acquire = acquire;
  }
  current(): HistorySnapshot | null {
    return this.#snapshot;
  }
  acquire(snapshot: HistorySnapshot): HistorySnapshotLease | null {
    if (this.#controller.signal.aborted || this.#snapshot?.generationId !== snapshot.generationId) {
      return null;
    }
    const id = snapshot.generationId;
    this.#leases.set(id, (this.#leases.get(id) ?? 0) + 1);
    let released = false;
    return {
      snapshot,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        const count = (this.#leases.get(id) ?? 1) - 1;
        if (count > 0) {
          this.#leases.set(id, count);
        } else {
          this.#leases.delete(id);
        }
        if (this.#snapshot?.generationId !== id || this.#controller.signal.aborted) {
          this.#scheduleRetirement();
        }
      },
    };
  }
  #scheduleRetirement(): void {
    if (this.#retirement !== null) {
      this.#retireAgain = true;
      return;
    }
    const keep = [
      ...this.#leases.keys(),
      ...(this.#snapshot ? [this.#snapshot.generationId] : []),
      ...(this.#pendingGeneration ? [this.#pendingGeneration] : []),
    ];
    this.#retirement = snapshotHistoryDatabase(this.#options, undefined, false, {
      retireKeep: keep,
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.#retirement = null;
        if (this.#retireAgain) {
          this.#retireAgain = false;
          this.#scheduleRetirement();
        }
      });
  }
  async #publish(snapshot: HistorySnapshot): Promise<void> {
    const manifestPath = join(this.#options.snapshotRoot, `.current-${snapshot.generationId}.tmp`);
    await writeFile(
      manifestPath,
      JSON.stringify({ generationId: snapshot.generationId, digest: snapshot.digest }),
      { mode: 0o600 },
    );
    await rename(manifestPath, join(this.#options.snapshotRoot, "current.json"));
  }
  invalidate(): void {
    this.#revision += 1;
    this.#dirty = true;
  }
  requestRefresh(): void {
    if (this.#controller.signal.aborted || this.#pending !== null || !this.#dirty) {
      return;
    }
    const revision = this.#revision;
    const generationId = randomUUID();
    this.#pendingGeneration = generationId;
    this.#dirty = false;
    this.#pending = (async () => {
      while (this.#retirement !== null) {
        // oxlint-disable-next-line no-await-in-loop -- An older cleanup must finish before a new unlisted generation can exist
        await this.#retirement;
      }
      if (!this.#retainedChecked) {
        this.#retainedChecked = true;
        const retained = await this.#acquire(this.#options, this.#controller.signal, true);
        if (retained.snapshot && revision === this.#revision) {
          this.#snapshot = retained.snapshot;
        }
      }
      const result = await this.#acquire(this.#options, this.#controller.signal, false, {
        generationId,
        publish: false,
      });
      if (!this.#controller.signal.aborted && revision === this.#revision) {
        this.#snapshot = result.snapshot;
        if (result.snapshot) {
          await this.#publish(result.snapshot);
        }
      }
    })()
      .catch(() => {
        this.#dirty = true;
      })
      .finally(() => {
        this.#pending = null;
        this.#pendingGeneration = null;
        this.#scheduleRetirement();
      });
  }
  async whenSettled(): Promise<void> {
    await this.#pending;
    while (this.#retirement !== null) {
      // oxlint-disable-next-line no-await-in-loop -- Reader releases can enqueue one final dependent retirement pass
      await this.#retirement;
    }
  }
  async close(): Promise<void> {
    this.#controller.abort();
    await this.whenSettled();
    this.#snapshot = null;
    this.#scheduleRetirement();
    await this.whenSettled();
  }
}
