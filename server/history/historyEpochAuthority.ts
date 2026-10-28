import { createHash, randomUUID } from "node:crypto";

import * as z from "zod";

import type { ResolvedRolloutLineage } from "../ingestion/rolloutLineage.ts";
import { SOURCE_GENERATION_PARSER_VERSION } from "../ingestion/sourceGeneration.ts";

const rangeSchema = z
  .strictObject({
    start: z.int().nonnegative(),
    endExclusive: z.int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .refine((range) => range.endExclusive >= range.start);
const proofSchema = z.strictObject({
  physical: z.string().min(1),
  decodedSize: z.int().nonnegative().optional(),
  ranges: z.array(rangeSchema).min(1).max(4096),
});
const stateSchema = z.strictObject({
  epoch: z.string().min(1),
  revision: z.string().min(1),
  proofs: z.array(proofSchema).min(1).max(16),
});
export type HistoryEpochProof = z.infer<typeof proofSchema>;
export type HistoryEpochState = z.infer<typeof stateSchema>;
export interface HistoryEpochStorage {
  read(key: string): unknown;
  write(key: string, value: HistoryEpochState): void;
}
export interface HistoryEpochTicket {
  readonly previous: HistoryEpochState | null;
}
export interface HistoryEpochSelection {
  readonly epoch: string;
}

/** Shared only by readers of one viewer repository, proof bytes must be freshly qualified by the receiving reader */
export class HistoryEpochAuthority {
  readonly #states = new Map<string, HistoryEpochState>();
  readonly #tickets = new WeakMap<HistoryEpochTicket, string>();
  readonly #selections = new WeakMap<
    HistoryEpochSelection,
    { key: string; revision: string | null }
  >();
  readonly #storage: HistoryEpochStorage | undefined;
  constructor(storage?: HistoryEpochStorage) {
    this.#storage = storage;
  }
  #read(key: string): HistoryEpochState | null {
    if (this.#storage) {
      const parsed = stateSchema.safeParse(this.#storage.read(key));
      return parsed.success ? parsed.data : null;
    }
    return this.#states.get(key) ?? null;
  }
  begin(lineage: ResolvedRolloutLineage): HistoryEpochTicket {
    const ref = lineage.segments.at(-1)?.ref;
    if (!ref) {
      throw new Error("history.epoch_lineage_unavailable");
    }
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          ref.codexHomeId,
          ref.stableThreadId,
          ref.physicalRolloutId,
          SOURCE_GENERATION_PARSER_VERSION,
          "common-history-epoch-v1",
        ]),
      )
      .digest("hex");
    const ticket = Object.freeze({ previous: structuredClone(this.#read(key)) });
    this.#tickets.set(ticket, key);
    return ticket;
  }
  /** Missing prior ranges are unresolved, a freshly observed mismatch is a new incarnation */
  select(
    ticket: HistoryEpochTicket,
    observed: readonly HistoryEpochProof[],
    initialEpoch?: string,
  ): HistoryEpochSelection | null {
    const key = this.#tickets.get(ticket);
    if (!key) {
      throw new Error("history.invalid_epoch_ticket");
    }
    const current = this.#read(key);
    let missing = false;
    let changed = false;
    for (const dependency of current?.proofs ?? []) {
      const actual = observed.find((proof) => proof.physical === dependency.physical);
      for (const old of dependency.ranges) {
        if (actual?.decodedSize !== undefined && old.endExclusive > actual.decodedSize) {
          changed = true;
          continue;
        }
        const verified = actual?.ranges.find(
          (range) => range.start === old.start && range.endExclusive === old.endExclusive,
        );
        if (!verified) {
          missing = true;
        } else if (verified.sha256 !== old.sha256) {
          changed = true;
        }
      }
    }
    if (missing && !changed) {
      return null;
    }
    const selection = Object.freeze({
      epoch:
        current && !changed
          ? current.epoch
          : current
            ? randomUUID()
            : (initialEpoch ?? randomUUID()),
    });
    this.#selections.set(selection, { key, revision: current?.revision ?? null });
    return selection;
  }
  /** Call synchronously with the page/association publication, after every asynchronous source fence */
  publish(selection: HistoryEpochSelection, proofs: readonly HistoryEpochProof[]): void {
    const expected = this.#selections.get(selection);
    this.#selections.delete(selection);
    if (!expected || (this.#read(expected.key)?.revision ?? null) !== expected.revision) {
      throw new Error("history.epoch_publication_superseded");
    }
    const next = stateSchema.parse({ epoch: selection.epoch, revision: randomUUID(), proofs });
    if (this.#storage) {
      this.#storage.write(expected.key, next);
    } else {
      this.#states.set(expected.key, next);
      if (this.#states.size > 128) {
        this.#states.delete(this.#states.keys().next().value!);
      }
    }
  }
}
