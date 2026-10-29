import { createHash, randomUUID } from "node:crypto";

import {
  observeSessionMetaSource,
  type SessionMetaPrefixObservation,
} from "#server/ingestion/sessionMetaPrefix.ts";
import { stableRead } from "#server/ingestion/stableRead.ts";
import {
  rolloutRefSchema,
  sourceGenerationSchema,
  type RolloutRef,
  type SourceGeneration,
} from "#shared/types/conversation.ts";

export interface ValidatedSourceGeneration {
  generation: SourceGeneration;
  reuse: "none" | "decoded" | "semantic";
}
export interface GenerationValidationOptions {
  parserVersion?: number;
  decoderVersion?: string;
}
export const SOURCE_GENERATION_PARSER_VERSION = 11;
function newSemanticEpoch(): string {
  return randomUUID();
}
function compatibleIdentity(left: SourceGeneration, right: SourceGeneration): boolean {
  return (
    left.codexHomeId === right.codexHomeId &&
    left.physicalRolloutId === right.physicalRolloutId &&
    left.parserVersion === right.parserVersion
  );
}
export class SourceGenerationFence {
  readonly #tokens = new Map<string, string>();
  begin(key: string): string {
    const token = randomUUID();
    this.#tokens.set(key, token);
    return token;
  }
  isCurrent(key: string, token: string): boolean {
    return this.#tokens.get(key) === token;
  }
  clear(): void {
    this.#tokens.clear();
  }
}
function sameObservation(
  a: SessionMetaPrefixObservation,
  b: SessionMetaPrefixObservation,
): boolean {
  return (
    a.device === b.device &&
    a.inode === b.inode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.regular === b.regular &&
    a.symbolicLink === b.symbolicLink
  );
}
function createGeneration(
  ref: RolloutRef,
  observation: SessionMetaPrefixObservation,
  options: GenerationValidationOptions,
): SourceGeneration {
  if (
    !observation.regular ||
    observation.symbolicLink ||
    !Number.isSafeInteger(Number(observation.size))
  ) {
    throw new Error("Expected a safely addressable regular rollout source");
  }
  return {
    codexHomeId: ref.codexHomeId,
    physicalRolloutId: ref.physicalRolloutId ?? `path:${ref.sourcePath}`,
    sourcePath: ref.sourcePath,
    representation: ref.representation,
    observation: {
      device: String(observation.device),
      inode: String(observation.inode),
      encodedSize: Number(observation.size),
      mtimeNs: String(observation.mtimeNs),
      ctimeNs: String(observation.ctimeNs),
    },
    encodedSha256: null,
    decodedSha256: null,
    decodedSize: null,
    validationScope: "full-stream",
    verifiedDecodedRanges: [],
    parserVersion: options.parserVersion ?? SOURCE_GENERATION_PARSER_VERSION,
    decoderVersion:
      options.decoderVersion ??
      (ref.representation === "plain-jsonl" ? "plain-v1" : "zstd-pending"),
    token: randomUUID(),
    semanticEpoch: null,
  };
}
export async function validateSourceGeneration(
  ref: RolloutRef,
  previous: SourceGeneration | null,
  signal?: AbortSignal,
  options: GenerationValidationOptions = {},
): Promise<ValidatedSourceGeneration> {
  rolloutRefSchema.parse(ref);
  if (ref.representation === "unsupported") {
    throw new Error("Unsupported rollout representation");
  }
  signal?.throwIfAborted();
  const before = await observeSessionMetaSource(ref.sourcePath);
  const next = createGeneration(ref, before, options);
  const hash = createHash("sha256");
  const prefixHash = createHash("sha256");
  const read = await stableRead(ref.sourcePath, {
    onChunk({ bytes, offset }) {
      signal?.throwIfAborted();
      hash.update(bytes);
      if (
        ref.representation === "plain-jsonl" &&
        previous?.decodedSize != null &&
        offset < previous.decodedSize
      ) {
        prefixHash.update(bytes.subarray(0, previous.decodedSize - offset));
      }
    },
  });
  const after = await observeSessionMetaSource(ref.sourcePath);
  signal?.throwIfAborted();
  if (read.status !== "stable" || !sameObservation(before, after)) {
    throw new Error("Source changed during generation validation");
  }
  next.encodedSha256 = hash.digest("hex");
  if (ref.representation === "plain-jsonl") {
    next.decodedSha256 = next.encodedSha256;
    next.decodedSize = read.size;
    next.semanticEpoch = newSemanticEpoch();
    next.verifiedDecodedRanges = [
      { start: 0, endExclusive: read.size, sha256: next.decodedSha256 },
    ];
  }
  let reuse: ValidatedSourceGeneration["reuse"] = "none";
  if (previous !== null && compatibleIdentity(previous, next)) {
    if (
      previous.encodedSha256 === next.encodedSha256 &&
      previous.decodedSha256 !== null &&
      previous.decoderVersion === next.decoderVersion &&
      previous.representation === next.representation
    ) {
      next.decodedSha256 = previous.decodedSha256;
      next.decodedSize = previous.decodedSize;
      next.verifiedDecodedRanges = previous.verifiedDecodedRanges;
      next.semanticEpoch = previous.semanticEpoch ?? newSemanticEpoch();
      reuse = "decoded";
    } else if (next.decodedSha256 !== null && previous.decodedSha256 === next.decodedSha256) {
      reuse = "semantic";
      next.semanticEpoch = previous.semanticEpoch ?? newSemanticEpoch();
    } else if (
      next.decodedSha256 !== null &&
      previous.decodedSha256 !== null &&
      previous.decodedSize !== null &&
      next.decodedSize! > previous.decodedSize &&
      prefixHash.digest("hex") === previous.decodedSha256
    ) {
      next.semanticEpoch = previous.semanticEpoch ?? newSemanticEpoch();
    }
  }
  return { generation: sourceGenerationSchema.parse(next), reuse };
}
export async function validateSourceRanges(
  ref: RolloutRef,
  ranges: readonly { start: number; endExclusive: number }[],
  _previous: SourceGeneration | null = null,
  signal?: AbortSignal,
  options: GenerationValidationOptions = {},
): Promise<ValidatedSourceGeneration> {
  rolloutRefSchema.parse(ref);
  if (ref.representation !== "plain-jsonl") {
    throw new Error("Selected encoded windows are not decoded Zstd ranges");
  }
  signal?.throwIfAborted();
  const before = await observeSessionMetaSource(ref.sourcePath);
  const next = createGeneration(ref, before, options);
  next.validationScope = "selected-range";
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.endExclusive) ||
      range.start < 0 ||
      range.endExclusive < range.start ||
      range.endExclusive > Number(before.size)
    ) {
      throw new RangeError("Invalid selected decoded range");
    }
    const hash = createHash("sha256");
    // oxlint-disable-next-line no-await-in-loop -- One selected dependency range is read at a time under the shared observation fence
    const read = await stableRead(ref.sourcePath, {
      start: range.start,
      endExclusive: range.endExclusive,
      onChunk({ bytes }) {
        signal?.throwIfAborted();
        hash.update(bytes);
      },
    });
    if (read.status !== "stable" || read.bytesRead !== range.endExclusive - range.start) {
      throw new Error("Source changed during selected-range validation");
    }
    next.verifiedDecodedRanges.push({ ...range, sha256: hash.digest("hex") });
  }
  const after = await observeSessionMetaSource(ref.sourcePath);
  signal?.throwIfAborted();
  if (!sameObservation(before, after)) {
    throw new Error("Source changed during selected-range validation");
  }
  return { generation: sourceGenerationSchema.parse(next), reuse: "none" };
}
/** Called only after the decoder validates completion against the hashed encoded input */
export function completeDecodedGeneration(
  generation: SourceGeneration,
  evidence: {
    encodedSha256: string;
    decodedSha256: string;
    decodedSize: number;
    decoderVersion: string;
    decodedPrefixSha256?: string;
  },
  previous: SourceGeneration | null = null,
): SourceGeneration {
  if (
    generation.validationScope !== "full-stream" ||
    generation.encodedSha256 === null ||
    generation.encodedSha256 !== evidence.encodedSha256
  ) {
    throw new Error("Decoded output does not match the validated encoded generation");
  }
  const preservesEpoch =
    previous !== null &&
    compatibleIdentity(generation, previous) &&
    previous.decodedSha256 !== null &&
    (previous.decodedSha256 === evidence.decodedSha256 ||
      (previous.decodedSize !== null &&
        evidence.decodedSize > previous.decodedSize &&
        evidence.decodedPrefixSha256 === previous.decodedSha256));
  return sourceGenerationSchema.parse({
    ...generation,
    decodedSha256: evidence.decodedSha256,
    decodedSize: evidence.decodedSize,
    decoderVersion: evidence.decoderVersion,
    semanticEpoch: preservesEpoch
      ? (previous.semanticEpoch ?? newSemanticEpoch())
      : newSemanticEpoch(),
    verifiedDecodedRanges: [
      { start: 0, endExclusive: evidence.decodedSize, sha256: evidence.decodedSha256 },
    ],
  });
}
export function historyEpochForGeneration(
  lineageEpoch: string,
  generation: SourceGeneration,
): string | null {
  return generation.semanticEpoch == null
    ? null
    : createHash("sha256")
        .update(JSON.stringify([lineageEpoch, generation.semanticEpoch]))
        .digest("hex");
}
