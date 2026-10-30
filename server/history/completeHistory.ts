import { createHash } from "node:crypto";

import { assembleHistoryRecords } from "#server/history/rolloutHistoryReader.ts";
import type { readCompleteRollout } from "#server/ingestion/completeRollout.ts";
import type { JsonlWindow } from "#server/ingestion/reverseJsonl.ts";
import { isFinalAnswerEligible, isFinalAnswerPhase } from "#shared/timeline/finalAnswer.ts";
import {
  historyPageSchema,
  type HistoryCoverage,
  type HistoryTurnWindow,
} from "#shared/types/history.ts";

/** Source-qualified full export uses the same raw item assembler as selected live history */
export function completeHistoryPage(source: Awaited<ReturnType<typeof readCompleteRollout>>) {
  const revision = createHash("sha256")
    .update(
      JSON.stringify(
        source.segments.map(({ generation }) => [
          generation.physicalRolloutId,
          generation.decodedSha256,
          generation.parserVersion,
        ]),
      ),
    )
    .digest("hex");
  const epoch = createHash("sha256")
    .update(JSON.stringify([source.historyEpoch, revision]))
    .digest("hex");
  const coverage: HistoryCoverage = { status: "complete", segments: [], gaps: [] };
  const turns: HistoryTurnWindow[] = [];
  let inherited: Parameters<typeof assembleHistoryRecords>[1];
  for (const [segmentOrder, entry] of source.segments.entries()) {
    const { segment, generation } = entry;
    const records = entry.records.filter(
      (record) =>
        segment.endOrdinalExclusive === null ||
        (record.ordinal! < segment.endOrdinalExclusive && record.byteEnd <= segment.endByteOffset!),
    );
    const end = records.at(-1)?.byteEnd ?? 0;
    const window: JsonlWindow = {
      records,
      unfinishedFinalRecord: false,
      scannedStart: 0,
      nextEndExclusive: end,
      reachedStart: true,
      budgetExceeded: false,
      errors: [],
    };
    const assembled = assembleHistoryRecords({ segment, opening: window, tail: window }, inherited);
    inherited = assembled.carried;
    const physical = segment.ref.physicalRolloutId!;
    const ranges = [
      {
        physicalRolloutId: physical,
        startOrdinal: records[0]?.ordinal ?? null,
        endOrdinalExclusive:
          records.at(-1)?.ordinal === undefined ? null : records.at(-1)!.ordinal! + 1,
        startDecodedByte: 0,
        endDecodedByteExclusive: end,
        ...(end === generation.decodedSize ? { sha256: generation.decodedSha256! } : {}),
      },
    ];
    coverage.segments.push({
      physicalRolloutId: physical,
      endOrdinalExclusive: segment.endOrdinalExclusive,
      endDecodedByteExclusive: segment.endByteOffset,
      coveredRanges: ranges,
      projectionWatermark: null,
      sourceWatermark: { nextOrdinal: records.at(-1)!.ordinal! + 1, nextByteOffset: end },
    });
    if (assembled.unsupported || assembled.unresolvedCutoff) {
      coverage.status = "partial";
      coverage.gaps.push({
        physicalRolloutId: physical,
        turnId: null,
        reason: assembled.unresolvedCutoff ? "ordinal-cutoff-unproved" : "unresolved-records",
        beforeOrdinal: null,
        afterOrdinal: null,
      });
    }
    for (const turn of assembled.turns) {
      const items = [...turn.items.values()].toSorted(
        (a, b) => a.record.byteStart - b.record.byteStart,
      );
      const opening = items.find(({ item }) => item.type !== "contextCompaction")?.item;
      const final =
        items.findLast(
          ({ item }) => item.type === "agentMessage" && isFinalAnswerPhase(item.phase),
        ) ??
        (turn.completion
          ? items.findLast(
              ({ item }) =>
                item.type === "agentMessage" &&
                isFinalAnswerEligible(item.phase, item.text, turn.completion!.text),
            )
          : undefined);
      const previous = turns.findIndex((candidate) => candidate.turnId === turn.id);
      if (previous >= 0) {
        turns.splice(previous, 1);
      }
      turns.push({
        turnId: turn.id,
        physicalRolloutId: physical,
        segmentOrder,
        order: turn.start.ordinal!,
        decodedByteOrder: turn.start.byteStart,
        orderKind: "ordinal",
        boundary: {
          status: turn.boundary || turn.id.startsWith("raw-turn-") ? "verified" : "unresolved",
          sourceTurnId: turn.id.startsWith("raw-turn-") ? null : turn.id,
          decodedByteStart: turn.start.byteStart,
          identityAliases: [],
        },
        context: turn.context,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
        opening: {
          itemId: opening?.type === "userMessage" ? opening.id : null,
          availability: opening?.type === "userMessage" ? "available" : "absent",
          item: opening?.type === "userMessage" ? opening : null,
        },
        items: items.map(({ item, record, updatedRecord }) => ({
          physicalRolloutId: physical,
          ordinal: record.ordinal ?? null,
          decodedByteStart: record.byteStart,
          decodedByteEnd: record.byteEnd,
          updatedAtOrdinal: updatedRecord.ordinal ?? null,
          updatedAtDecodedByte: updatedRecord.byteStart,
          detail: "full",
          itemId: item.id,
          item,
        })),
        itemsView: "full",
        beforeCursor: null,
        afterCursor: null,
        loadedRanges: ranges,
        coverage: structuredClone(coverage),
        finalAnswerItemId: final?.item.id ?? null,
        historyEpoch: epoch,
        contentRevision: revision,
        reviewEvidence: {
          availability: assembled.unresolvedCutoff ? "unresolved" : "complete",
          records: assembled.reviewRecords,
        },
      });
    }
  }
  return historyPageSchema.parse({
    threadId: source.ref.stableThreadId,
    metadataRevision: null,
    contentRevision: revision,
    historyEpoch: epoch,
    turns,
    beforeCursor: null,
    afterCursor: null,
    coverage,
    preparation: coverage.status === "complete" ? "ready" : "partial",
  });
}
