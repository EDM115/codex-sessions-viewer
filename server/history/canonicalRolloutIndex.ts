import { createHash, randomUUID } from "node:crypto";

import { adaptCoreTurnItem } from "#server/history/nativeItemAdapter.ts";
import type {
  CanonicalEvidenceProvider,
  CanonicalEvidenceRange,
} from "#server/history/nativeProjectionQualification.ts";
import { JsonlStreamParser } from "#server/ingestion/jsonlStream.ts";
import type { ResolvedRolloutLineage } from "#server/ingestion/rolloutLineage.ts";
import { observeSessionMetaSource } from "#server/ingestion/sessionMetaPrefix.ts";
import { validateSourceRanges } from "#server/ingestion/sourceGeneration.ts";
import { readStableBytes, stableRead } from "#server/ingestion/stableRead.ts";
import { sourceGenerationSchema, type SourceGeneration } from "#shared/types/conversation.ts";

interface PreparedWindow {
  source: SourceGeneration;
  lineage: string;
  metadata: Buffer;
  start: number;
  startOrdinal: number;
  nextOrdinal: number;
  anchorSha256: string;
  expires: number;
}
const tickets = new WeakMap<object, PreparedWindow>();
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function lineageIdentity(lineage: ResolvedRolloutLineage): string {
  return JSON.stringify([
    lineage.historyEpoch,
    lineage.segments.map((segment) => [
      segment.ref,
      segment.bodyStartOrdinal,
      segment.displayStartOrdinal,
      segment.endByteOffset,
      segment.endOrdinalExclusive,
    ]),
  ]);
}
/** Only a live completed index pass can issue this nonserializable, single-use authority */
export function consumePreparedCanonicalWindow(
  ticket: object | undefined,
  lineage: ResolvedRolloutLineage,
  source: SourceGeneration,
): PreparedWindow | null {
  if (!ticket) {
    return null;
  }
  const prepared = tickets.get(ticket);
  tickets.delete(ticket);
  if (
    !prepared ||
    prepared.expires < Date.now() ||
    JSON.stringify(prepared.source) !== JSON.stringify(source) ||
    prepared.lineage !== lineageIdentity(lineage)
  ) {
    return null;
  }
  return prepared;
}
export class CanonicalRolloutIndex implements CanonicalEvidenceProvider {
  #prepared: { ticket: object; range: CanonicalEvidenceRange } | null = null;
  #revision = 0;
  readonly #tickets = new Set<object>();
  invalidate(): void {
    this.#revision += 1;
    for (const ticket of this.#tickets) {
      tickets.delete(ticket);
    }
    this.#tickets.clear();
    this.#prepared = null;
  }
  async prepare(
    lineage: ResolvedRolloutLineage,
    signal?: AbortSignal,
  ): Promise<SourceGeneration | null> {
    this.invalidate();
    const revision = this.#revision;
    if (lineage.status !== "complete" || lineage.segments.length !== 1) {
      return null;
    }
    const segment = lineage.segments[0]!;
    if (segment.ref.representation !== "plain-jsonl" || segment.endByteOffset !== null) {
      return null;
    }
    const initial = (await validateSourceRanges(segment.ref, [], null, signal)).generation;
    const fullHash = createHash("sha256");
    const recordChain = createHash("sha256");
    const starts: { start: number; ordinal: number; anchorSha256: string }[] = [];
    let nextOrdinal = segment.bodyStartOrdinal - 1;
    let metadataEnd = 0;
    let canonical = true;
    const parser = new JsonlStreamParser({
      maxRecordBytes: 1024 * 1024,
      onError() {
        throw new Error("index.invalid_record");
      },
      onRecord(record) {
        signal?.throwIfAborted();
        const value = record.value;
        if (metadataEnd === 0) {
          metadataEnd = record.byteEnd;
        }
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const payload = value["payload"];
          const isEvent =
            value["type"] === "event_msg" &&
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload);
          if (record.byteStart === 0) {
            canonical &&= value["type"] === "session_meta";
          } else if (
            !["turn_context", "token_usage"].includes(
              typeof value["type"] === "string" ? value["type"] : "",
            )
          ) {
            canonical &&=
              isEvent &&
              typeof payload["turn_id"] === "string" &&
              payload["turn_id"].length > 0 &&
              (payload["type"] === "item_completed"
                ? adaptCoreTurnItem(payload["item"], payload) !== null
                : ["turn_started", "turn_complete", "turn_aborted"].includes(
                    typeof payload["type"] === "string" ? payload["type"] : "",
                  ));
          }
          if (
            value["type"] === "event_msg" &&
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            payload["type"] === "turn_started"
          ) {
            starts.push({
              start: record.byteStart,
              ordinal: nextOrdinal,
              anchorSha256: recordChain.copy().digest("hex"),
            });
            if (starts.length > 20) {
              starts.shift();
            }
          }
        } else {
          canonical = false;
        }
        recordChain.update(record.rangeSha256!);
        nextOrdinal += 1;
      },
    });
    const read = await stableRead(segment.ref.sourcePath, {
      onChunk({ bytes, offset }) {
        signal?.throwIfAborted();
        fullHash.update(bytes);
        parser.write(bytes, offset);
      },
    });
    if (
      !canonical ||
      read.status !== "stable" ||
      parser.finish().pending.length > 0 ||
      starts.length === 0 ||
      metadataEnd > 64 * 1024
    ) {
      return null;
    }
    const start = starts[0]!;
    if (read.size - start.start + metadataEnd > 2 * 1024 * 1024) {
      return null;
    }
    const metadata = await readStableBytes(segment.ref.sourcePath, { endExclusive: metadataEnd });
    const suffix = await readStableBytes(segment.ref.sourcePath, {
      start: start.start,
      endExclusive: read.size,
    });
    const after = (await validateSourceRanges(segment.ref, [], null, signal)).generation;
    if (
      metadata.read.status !== "stable" ||
      suffix.read.status !== "stable" ||
      JSON.stringify(initial.observation) !== JSON.stringify(after.observation) ||
      revision !== this.#revision
    ) {
      return null;
    }
    const sha256 = fullHash.digest("hex");
    const source = sourceGenerationSchema.parse({
      ...after,
      validationScope: "full-stream",
      encodedSha256: sha256,
      decodedSha256: sha256,
      decodedSize: read.size,
      semanticEpoch: randomUUID(),
      verifiedDecodedRanges: [{ start: 0, endExclusive: read.size, sha256 }],
    });
    const ticket = {};
    this.#tickets.add(ticket);
    tickets.set(ticket, {
      source: structuredClone(source),
      lineage: lineageIdentity(lineage),
      metadata: metadata.bytes,
      start: start.start,
      startOrdinal: start.ordinal,
      nextOrdinal,
      anchorSha256: start.anchorSha256,
      expires: Date.now() + 30000,
    });
    const range: CanonicalEvidenceRange = {
      physicalRolloutId: source.physicalRolloutId,
      start: start.start,
      endExclusive: read.size,
      startOrdinal: start.ordinal,
      sha256: hash(suffix.bytes),
      preparedIndex: ticket,
    };
    this.#prepared = { ticket, range };
    return source;
  }
  async proposeRanges(
    lineage: ResolvedRolloutLineage,
    source: SourceGeneration,
    signal?: AbortSignal,
  ): Promise<readonly CanonicalEvidenceRange[] | null> {
    signal?.throwIfAborted();
    const selected = this.#prepared;
    this.#prepared = null;
    if (!selected) {
      return null;
    }
    const prepared = tickets.get(selected.ticket);
    if (
      !prepared ||
      prepared.source.token !== source.token ||
      prepared.lineage !== lineageIdentity(lineage)
    ) {
      tickets.delete(selected.ticket);
      return null;
    }
    const observed = await observeSessionMetaSource(source.sourcePath);
    const before = source.observation;
    if (
      String(observed.device) !== before.device ||
      String(observed.inode) !== before.inode ||
      Number(observed.size) !== before.encodedSize ||
      String(observed.mtimeNs) !== before.mtimeNs ||
      String(observed.ctimeNs) !== before.ctimeNs
    ) {
      tickets.delete(selected.ticket);
      return null;
    }
    return [selected.range];
  }
}
