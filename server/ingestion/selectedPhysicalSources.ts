import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

import {
  parseRolloutFilename,
  rolloutRefFromSource,
  sourceHomePath,
} from "#server/ingestion/rolloutIdentity.ts";
import type { RolloutRef } from "#shared/types/conversation.ts";

/** Explicit ancestry preparation only, directory enumeration resumes after a bounded entry slice */
export class SelectedPhysicalSources {
  readonly #entries = new Map<
    string,
    { iterator: AsyncGenerator<string>; candidates: Map<string, RolloutRef[]>; complete: boolean }
  >();
  readonly #entryBudget: number;
  constructor(entryBudget = 4096) {
    this.#entryBudget = entryBudget;
  }
  async *#walk(path: string): AsyncGenerator<string> {
    let directory;
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return;
      }
      directory = await opendir(path, { bufferSize: 16 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for await (const entry of directory) {
      const child = join(path, entry.name);
      // Every entry spends budget, including directories and unrelated files
      yield entry.isFile() ? child : "";
      if (entry.isDirectory()) {
        yield* this.#walk(child);
      }
    }
  }
  async *#scan(home: string) {
    yield* this.#walk(join(home, "sessions"));
    yield* this.#walk(join(home, "archived_sessions"));
  }
  /** Refresh completed discovery once per outer lineage operation, retain unfinished enumeration */
  beginLineage(selected: RolloutRef) {
    const home = sourceHomePath(selected.sourcePath);
    if (this.#entries.get(home)?.complete) {
      this.#entries.delete(home);
    }
  }
  async resolve(
    selected: RolloutRef,
    physical: string,
    signal?: AbortSignal,
  ): Promise<RolloutRef | null> {
    signal?.throwIfAborted();
    const home = sourceHomePath(selected.sourcePath);
    let scan = this.#entries.get(home);
    scan ??= { iterator: this.#scan(home), candidates: new Map(), complete: false };
    this.#entries.set(home, scan);
    try {
      for (let count = 0; count < this.#entryBudget; count += 1) {
        signal?.throwIfAborted();
        // oxlint-disable-next-line no-await-in-loop -- A bounded directory cursor is resumed only by explicit selected ancestry requests
        const next = await scan.iterator.next();
        signal?.throwIfAborted();
        if (next.done) {
          scan.complete = true;
          break;
        }
        const identity = parseRolloutFilename(next.value);
        if (!identity?.physicalRolloutId) {
          continue;
        }
        const matches = scan.candidates.get(identity.physicalRolloutId) ?? [];
        matches.push(rolloutRefFromSource(next.value, null, selected.codexHomeId));
        scan.candidates.set(identity.physicalRolloutId, matches);
      }
      if (!scan.complete) {
        throw new Error("lineage.preparation_pending");
      }
      const matches = scan.candidates.get(physical) ?? [];
      const plain = matches.filter((candidate) => candidate.representation === "plain-jsonl");
      const choices = plain.length ? plain : matches;
      return choices.length === 1 ? choices[0]! : null;
    } catch (error) {
      if (error instanceof Error && error.message === "lineage.preparation_pending") {
        throw error;
      }
      this.#entries.delete(home);
      await scan.iterator.return(undefined);
      throw error;
    }
  }
  async close() {
    await Promise.all([...this.#entries.values()].map((scan) => scan.iterator.return(undefined)));
    this.#entries.clear();
  }
}
