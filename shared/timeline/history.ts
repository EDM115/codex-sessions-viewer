import type { HistoryTurnWindow } from "../types/history.ts";
import { unverifiedReviewRecord } from "./reviewVisibility.ts";

function compareCoordinates(
  leftByte: number | undefined,
  rightByte: number | undefined,
  leftOrdinal: number | null,
  rightOrdinal: number | null,
): number | null {
  if (leftByte !== undefined && rightByte !== undefined) {
    return leftByte - rightByte;
  }
  if (leftOrdinal !== null && rightOrdinal !== null) {
    return leftOrdinal - rightOrdinal;
  }
  return null;
}
function related(left: HistoryTurnWindow, right: HistoryTurnWindow): boolean {
  if (
    left.historyEpoch !== right.historyEpoch ||
    left.physicalRolloutId !== right.physicalRolloutId
  ) {
    return false;
  }
  const aliases = new Set([left.turnId, ...(left.boundary?.identityAliases ?? [])]);
  return [right.turnId, ...(right.boundary?.identityAliases ?? [])].some((id) => aliases.has(id));
}
export function historyItemIslands(window: HistoryTurnWindow): string[][] {
  if (window.itemIslands) {
    return window.itemIslands;
  }
  const ids = window.items.map((item) => item.itemId);
  const islands: string[][] =
    window.opening.itemId && !ids.includes(window.opening.itemId) ? [[window.opening.itemId]] : [];
  let previous: HistoryTurnWindow["items"][number] | undefined;
  for (const item of window.items) {
    const adjacent = previous;
    const connected =
      adjacent &&
      adjacent.physicalRolloutId === item.physicalRolloutId &&
      window.loadedRanges.some((range) => {
        if (range.physicalRolloutId !== item.physicalRolloutId) {
          return false;
        }
        if (
          adjacent.decodedByteStart !== undefined &&
          adjacent.decodedByteEnd !== undefined &&
          item.decodedByteStart !== undefined &&
          item.decodedByteEnd !== undefined &&
          range.startDecodedByte !== undefined &&
          range.endDecodedByteExclusive !== undefined
        ) {
          return (
            adjacent.decodedByteStart <= item.decodedByteStart &&
            range.startDecodedByte <= adjacent.decodedByteStart &&
            range.endDecodedByteExclusive >= Math.max(adjacent.decodedByteEnd, item.decodedByteEnd)
          );
        }
        return (
          adjacent.ordinal !== null &&
          item.ordinal !== null &&
          range.startOrdinal !== null &&
          range.endOrdinalExclusive !== null &&
          adjacent.ordinal <= item.ordinal &&
          range.startOrdinal <= adjacent.ordinal &&
          range.endOrdinalExclusive > item.ordinal
        );
      });
    if (connected) {
      islands.at(-1)!.push(item.itemId);
    } else {
      islands.push([item.itemId]);
    }
    previous = item;
  }
  return islands;
}

/** A new page revision does not qualify payloads omitted from that page */
export function retainHistoryWindows(
  current: readonly HistoryTurnWindow[],
  revision: string,
): HistoryTurnWindow[] {
  return current.map((window) =>
    window.contentRevision === revision
      ? window
      : {
          ...window,
          items: window.items.map((item) =>
            item.detail === "full" ? { ...item, detail: "unresolved" as const } : item,
          ),
          opening:
            window.opening.availability === "available"
              ? { ...window.opening, availability: "unresolved" as const }
              : window.opening,
          ...(window.reviewEvidence
            ? {
                reviewEvidence: {
                  availability: "unresolved" as const,
                  records: window.reviewEvidence.records.map(unverifiedReviewRecord),
                },
              }
            : {}),
        },
  );
}
function mergedItemIslands(windows: readonly HistoryTurnWindow[]): string[][] {
  const islands: Set<string>[] = [];
  for (const group of windows.flatMap(historyItemIslands)) {
    const overlapping = islands.filter((island) => group.some((id) => island.has(id)));
    const merged = new Set([...group, ...overlapping.flatMap((island) => [...island])]);
    for (const island of overlapping) {
      islands.splice(islands.indexOf(island), 1);
    }
    islands.push(merged);
  }
  return islands.map((island) => Array.from(island));
}

/** Only explicit source-proved aliases join islands, the first displayed component identity survives */
function mergedReviewEvidence(
  matches: readonly HistoryTurnWindow[],
  next: HistoryTurnWindow,
): HistoryTurnWindow["reviewEvidence"] {
  const prior = matches.flatMap((window) =>
    (window.reviewEvidence?.records ?? []).map((record) =>
      window.contentRevision !== next.contentRevision ||
      !next.reviewEvidence ||
      window.reviewEvidence?.availability === "unresolved"
        ? unverifiedReviewRecord(record)
        : record,
    ),
  );
  if (next.reviewEvidence?.availability === "complete") {
    return {
      ...next.reviewEvidence,
      availability: next.reviewEvidence.records.some(
        (record) =>
          record.logicalVisibility !== "visible" && record.logicalVisibility !== "context-only",
      )
        ? "unresolved"
        : "complete",
    };
  }
  if (!next.reviewEvidence && prior.length === 0) {
    return undefined;
  }
  const records = [
    ...new Map(
      [
        ...prior,
        ...(next.reviewEvidence?.records.map((record) =>
          next.reviewEvidence?.availability === "unresolved"
            ? unverifiedReviewRecord(record)
            : record,
        ) ?? []),
      ].map((record) => [
        JSON.stringify([
          record.identity.codexHomeId,
          record.identity.physicalRolloutId,
          record.identity.decodedByteStart,
        ]),
        record,
      ]),
    ).values(),
  ];
  const unresolved =
    !next.reviewEvidence ||
    matches.some(
      (window) =>
        window.contentRevision !== next.contentRevision ||
        window.reviewEvidence?.availability === "unresolved",
    );
  return {
    availability: unresolved ? "unresolved" : (next.reviewEvidence?.availability ?? "partial"),
    records,
  };
}

export function mergeHistoryWindows(
  current: readonly HistoryTurnWindow[],
  incoming: readonly HistoryTurnWindow[],
  continuation?: { turnId: string; cursor: string; direction: "before" | "after" },
  placement?: string,
): HistoryTurnWindow[] {
  const revision = incoming[0]?.contentRevision;
  const windows = revision ? retainHistoryWindows(current, revision) : [...current];
  let prependCount = 0;
  for (const next of incoming) {
    const matches = windows.filter((entry) => related(entry, next));
    if (!matches.length) {
      windows.splice(placement === "before" ? prependCount++ : windows.length, 0, {
        ...next,
        itemIslands: historyItemIslands(next),
      });
      continue;
    }
    const first = matches[0]!;
    const items = new Map<string, HistoryTurnWindow["items"][number]>();
    for (const window of [...matches, next]) {
      for (const item of window.items) {
        const key = JSON.stringify([item.physicalRolloutId, item.itemId]);
        const old = items.get(key);
        if (old?.item && item.detail === "unresolved") {
          items.set(key, { ...old, detail: "unresolved" });
          continue;
        }
        const updateOrder = old
          ? compareCoordinates(
              item.updatedAtDecodedByte,
              old.updatedAtDecodedByte,
              item.updatedAtOrdinal,
              old.updatedAtOrdinal,
            )
          : 0;
        if (old && updateOrder === null) {
          items.set(key, { ...old, detail: "unresolved" });
          continue;
        }
        if (!old || (updateOrder !== null && updateOrder >= 0)) {
          items.set(key, item);
        }
      }
    }
    const ranges = [
      ...new Map(
        [...matches, next]
          .flatMap((entry) => entry.loadedRanges)
          .map((range) => [JSON.stringify(range), range]),
      ).values(),
    ];
    const ordered = ranges.toSorted(
      (a, b) =>
        compareCoordinates(
          a.startDecodedByte,
          b.startDecodedByte,
          a.startOrdinal,
          b.startOrdinal,
        ) ?? 0,
    );
    const islands: typeof ranges = [];
    for (const range of ordered) {
      const previous = islands.at(-1);
      if (
        previous &&
        previous.physicalRolloutId === range.physicalRolloutId &&
        previous.startDecodedByte !== undefined &&
        previous.endDecodedByteExclusive !== undefined &&
        range.startDecodedByte !== undefined &&
        range.endDecodedByteExclusive !== undefined &&
        range.startDecodedByte <= previous.endDecodedByteExclusive
      ) {
        islands[islands.length - 1] = {
          ...previous,
          endDecodedByteExclusive: Math.max(
            previous.endDecodedByteExclusive,
            range.endDecodedByteExclusive,
          ),
          startOrdinal:
            previous.startOrdinal !== null && range.startOrdinal !== null
              ? Math.min(previous.startOrdinal, range.startOrdinal)
              : null,
          endOrdinalExclusive:
            previous.endOrdinalExclusive !== null && range.endOrdinalExclusive !== null
              ? Math.max(previous.endOrdinalExclusive, range.endOrdinalExclusive)
              : null,
          sha256: undefined,
        };
      } else {
        islands.push(range);
      }
    }
    let opening =
      next.opening.availability === "notLoaded"
        ? (matches.find((entry) => entry.opening.availability !== "notLoaded")?.opening ??
          next.opening)
        : next.opening;
    const observedOpening = next.items.find((item) => item.itemId === opening.itemId);
    if (observedOpening?.detail === "full" && observedOpening.item) {
      opening = { ...opening, availability: "available", item: observedOpening.item };
    } else if (observedOpening?.detail === "unresolved" && opening.availability === "available") {
      opening = { ...opening, availability: "unresolved" };
    }
    const gaps = [
      ...new Map(
        [...matches, next]
          .flatMap((entry) => entry.coverage.gaps)
          .map((gap) => [JSON.stringify(gap), gap]),
      ).values(),
    ];
    const merged: HistoryTurnWindow = {
      ...first,
      ...next,
      reviewEvidence: mergedReviewEvidence(matches, next),
      turnId: first.turnId,
      order: Math.min(
        ...matches
          .filter((entry) => (entry.orderKind ?? "ordinal") === (next.orderKind ?? "ordinal"))
          .map((entry) => entry.order),
        next.order,
      ),
      decodedByteOrder: [...matches, next].every((entry) => entry.decodedByteOrder !== undefined)
        ? Math.min(...matches.map((entry) => entry.decodedByteOrder!), next.decodedByteOrder!)
        : next.decodedByteOrder,
      opening,
      items: [...items.values()].toSorted(
        (a, b) =>
          compareCoordinates(a.decodedByteStart, b.decodedByteStart, a.ordinal, b.ordinal) ?? 0,
      ),
      loadedRanges: islands,
      beforeCursor: next.beforeCursor ?? first.beforeCursor,
      afterCursor: next.afterCursor ?? first.afterCursor,
      coverage: {
        ...next.coverage,
        status: islands.length > 1 ? "partial" : next.coverage.status,
        gaps: next.coverage.status === "complete" && islands.length <= 1 ? [] : gaps,
      },
      boundary: next.boundary
        ? {
            ...next.boundary,
            identityAliases: [
              ...new Set([
                ...matches.flatMap((entry) => [
                  entry.turnId,
                  ...(entry.boundary?.identityAliases ?? []),
                ]),
                next.turnId,
                ...next.boundary.identityAliases,
              ]),
            ].filter((id) => id !== first.turnId),
          }
        : first.boundary,
    };
    const completeItems =
      next.itemsView === "full" &&
      next.coverage.status === "complete" &&
      merged.items.every(
        (item) =>
          item.detail === "full" &&
          next.items.some((candidate) => candidate.itemId === item.itemId),
      );
    merged.itemIslands = completeItems
      ? [
          [
            ...new Set([
              ...merged.items.map((item) => item.itemId),
              ...(opening.itemId ? [opening.itemId] : []),
            ]),
          ],
        ]
      : mergedItemIslands([...matches, next]);
    const contiguous =
      continuation &&
      matches.find(
        (entry) =>
          (entry.turnId === continuation.turnId ||
            entry.boundary?.identityAliases.includes(continuation.turnId)) &&
          entry.preparation?.cursor !== continuation.cursor &&
          (continuation.direction === "before" ? entry.beforeCursor : entry.afterCursor) ===
            continuation.cursor,
      );
    if (contiguous && continuation) {
      if (continuation.direction === "before") {
        merged.beforeCursor = next.beforeCursor;
      } else {
        merged.afterCursor = next.afterCursor;
      }
      const oldEdge =
        continuation.direction === "before" ? contiguous.items[0] : contiguous.items.at(-1);
      const newEdge = continuation.direction === "before" ? next.items.at(-1) : next.items[0];
      if (oldEdge && newEdge) {
        merged.itemIslands = mergedItemIslands([
          { ...merged, itemIslands: [...merged.itemIslands, [oldEdge.itemId, newEdge.itemId]] },
        ]);
      }
    }
    const preparing =
      continuation && matches.some((entry) => entry.preparation?.cursor === continuation.cursor);
    if (preparing) {
      merged.preparation = next.preparation;
      if (first.afterCursor === continuation.cursor) {
        merged.afterCursor = next.afterCursor;
      }
    }
    if (completeItems) {
      merged.beforeCursor = next.beforeCursor;
      merged.afterCursor = next.afterCursor;
      merged.preparation = next.preparation;
    }
    windows.splice(windows.indexOf(first), 1, merged);
    for (const duplicate of matches.slice(1)) {
      windows.splice(windows.indexOf(duplicate), 1);
    }
  }
  return windows.toSorted((a, b) => {
    const segment = (a.segmentOrder ?? 0) - (b.segmentOrder ?? 0);
    if (segment !== 0) {
      return segment;
    }
    if (a.decodedByteOrder !== undefined && b.decodedByteOrder !== undefined) {
      return a.decodedByteOrder - b.decodedByteOrder;
    }
    return (a.orderKind ?? "ordinal") === (b.orderKind ?? "ordinal") ? a.order - b.order : 0;
  });
}
