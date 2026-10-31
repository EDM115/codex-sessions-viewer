import { observeSessionMetaSource } from "#server/ingestion/sessionMetaPrefix.ts";

interface SelectionObservation {
  references: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  pending: Promise<void>;
  fingerprint: string | null;
}
/** SSE selection owners keep only exact known source families under observation */
export class SelectedHistoryObserver {
  readonly #selections = new Map<string, SelectionObservation>();
  readonly #sources: (id: string) => string[];
  readonly #changed: (id: string) => void;
  readonly #observe: typeof observeSessionMetaSource;
  readonly #pending = new Set<Promise<void>>();
  #closed = false;
  constructor(
    sources: (id: string) => string[],
    changed: (id: string) => void,
    observe = observeSessionMetaSource,
  ) {
    this.#sources = sources;
    this.#changed = changed;
    this.#observe = observe;
  }
  acquire(id: string): () => void {
    if (this.#closed) {
      throw new Error("history.closed");
    }
    this.#sources(id);
    let selection = this.#selections.get(id);
    if (!selection) {
      selection = {
        references: 0,
        controller: new AbortController(),
        timer: null,
        pending: Promise.resolve(),
        fingerprint: null,
      };
      this.#selections.set(id, selection);
      const active = selection;
      const poll = () => {
        active.pending = this.#poll(id, active).finally(() => {
          this.#pending.delete(active.pending);
          if (!active.controller.signal.aborted) {
            active.timer = setTimeout(poll, 1000);
            active.timer.unref();
          }
        });
        this.#pending.add(active.pending);
      };
      poll();
    }
    selection.references += 1;
    const active = selection;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      active.references -= 1;
      if (active.references === 0) {
        active.controller.abort();
        if (active.timer) {
          clearTimeout(active.timer);
        }
        if (this.#selections.get(id) === active) {
          this.#selections.delete(id);
        }
      }
    };
  }
  async #poll(id: string, owner: SelectionObservation): Promise<void> {
    try {
      const paths = [
        ...new Set(
          this.#sources(id).flatMap((path) => {
            const plain = path.replace(/\.zst$/u, "");
            return [plain, `${plain}.zst`];
          }),
        ),
      ].toSorted();
      const observations: unknown[] = [];
      for (const path of paths) {
        if (owner.controller.signal.aborted) {
          return;
        }
        try {
          // oxlint-disable-next-line no-await-in-loop -- Only selected exact file metadata is probed, serially and cancelably
          observations.push([path, await this.#observe(path)]);
        } catch (error) {
          observations.push([
            path,
            error instanceof Error && "code" in error ? error.code : "unavailable",
          ]);
        }
      }
      if (owner.controller.signal.aborted) {
        return;
      }
      const fingerprint = JSON.stringify(observations, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      );
      if (fingerprint !== owner.fingerprint) {
        owner.fingerprint = fingerprint;
        this.#changed(id);
      }
    } catch {
      if (!owner.controller.signal.aborted && owner.fingerprint !== "unavailable") {
        owner.fingerprint = "unavailable";
        this.#changed(id);
      }
    }
  }
  async close() {
    this.#closed = true;
    const active = [...this.#selections.values()];
    for (const owner of active) {
      owner.controller.abort();
      if (owner.timer) {
        clearTimeout(owner.timer);
      }
    }
    await Promise.allSettled(this.#pending);
    this.#selections.clear();
  }
}
