import type { PreparationResult } from "../../shared/types/library.ts";

export type MaterializationPriority = "open" | "visible" | "deep-search";

type MaterializationWorker = (
  id: string,
  priority: MaterializationPriority,
) => Promise<PreparationResult>;

interface QueueEntry {
  id: string;
  priority: MaterializationPriority;
  sequence: number;
  state: "queued" | "running";
  owners: Set<string | null>;
  promise: Promise<PreparationResult>;
  resolve: (result: PreparationResult) => void;
}

const priorityRank: Record<MaterializationPriority, number> = {
  open: 2,
  visible: 1,
  "deep-search": 0,
};

function deferredEntry(
  id: string,
  priority: MaterializationPriority,
  sequence: number,
  owner: string | undefined,
): QueueEntry {
  let resolve!: (result: PreparationResult) => void;
  const promise = new Promise<PreparationResult>((settle) => {
    resolve = settle;
  });
  return {
    id,
    priority,
    sequence,
    state: "queued",
    owners: new Set([owner ?? null]),
    promise,
    resolve,
  };
}

export class MaterializationQueue {
  readonly #worker: MaterializationWorker;
  readonly #entries = new Map<string, QueueEntry>();
  readonly #closeWaiters = new Set<() => void>();
  #active: QueueEntry | null = null;
  #sequence = 0;
  #closed = false;

  constructor(worker: MaterializationWorker) {
    this.#worker = worker;
  }

  enqueue(
    ids: readonly string[],
    priority: MaterializationPriority,
    owner?: string,
  ): Promise<PreparationResult[]> {
    if (this.#closed) {
      return Promise.resolve(
        ids.map((id) => ({
          id,
          state: "cold" as const,
          error: "Materialization queue is closed.",
        })),
      );
    }
    const promises = ids.map((id) => {
      let entry = this.#entries.get(id);
      if (entry === undefined) {
        this.#sequence += 1;
        entry = deferredEntry(id, priority, this.#sequence, owner);
        this.#entries.set(id, entry);
      } else {
        entry.owners.add(owner ?? null);
        if (entry.state === "queued" && priorityRank[priority] > priorityRank[entry.priority]) {
          entry.priority = priority;
        }
      }
      return entry.promise;
    });
    this.#drain();
    return Promise.all(promises);
  }

  cancelOwner(owner: string): void {
    for (const entry of this.#entries.values()) {
      entry.owners.delete(owner);
      if (entry.state !== "queued" || entry.owners.size > 0) {
        continue;
      }
      this.#entries.delete(entry.id);
      entry.resolve({
        id: entry.id,
        state: "cold",
        error: "Materialization was cancelled.",
      });
    }
  }

  #next(): QueueEntry | null {
    return (
      [...this.#entries.values()]
        .filter(({ state }) => state === "queued")
        .toSorted(
          (left, right) =>
            priorityRank[right.priority] - priorityRank[left.priority] ||
            left.sequence - right.sequence,
        )[0] ?? null
    );
  }

  #drain(): void {
    if (this.#active !== null || this.#closed) {
      return;
    }
    const entry = this.#next();
    if (entry === null) {
      this.#resolveCloseWaiters();
      return;
    }
    this.#active = entry;
    entry.state = "running";
    void this.#run(entry);
  }

  async #run(entry: QueueEntry): Promise<void> {
    let result: PreparationResult;
    try {
      result = await this.#worker(entry.id, entry.priority);
    } catch (error) {
      result = {
        id: entry.id,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.#entries.delete(entry.id);
    this.#active = null;
    entry.resolve(result);
    this.#drain();
    this.#resolveCloseWaiters();
  }

  #resolveCloseWaiters(): void {
    if (!this.#closed || this.#active !== null) {
      return;
    }
    for (const resolve of this.#closeWaiters) {
      resolve();
    }
    this.#closeWaiters.clear();
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const entry of this.#entries.values()) {
        if (entry.state !== "queued") {
          continue;
        }
        this.#entries.delete(entry.id);
        entry.resolve({
          id: entry.id,
          state: "cold",
          error: "Materialization queue is closed.",
        });
      }
    }
    if (this.#active === null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#closeWaiters.add(resolve);
    });
  }
}
