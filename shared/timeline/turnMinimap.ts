import type { TurnNavigatorItem } from "../types/conversation.ts";

const MARKER_WIDTHS = [18, 30, 44, 60] as const;

export interface VirtualRowPosition {
  index: number;
  start: number;
  end: number;
}

export function activeVirtualRowIndex(
  rows: readonly VirtualRowPosition[],
  readingLine: number,
): number | null {
  if (rows.length === 0) {
    return null;
  }
  const containing = rows.find(({ start, end }) => start <= readingLine && readingLine < end);
  if (containing !== undefined) {
    return containing.index;
  }
  return rows.toReversed().find(({ start }) => start <= readingLine)?.index ?? rows[0]!.index;
}

export function markerWidthForBucket(bucket: TurnNavigatorItem["proseLengthBucket"]): number {
  return MARKER_WIDTHS[bucket - 1]!;
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

export function minimapPreview(item: TurnNavigatorItem): { prompt: string; assistant: string } {
  return {
    prompt: singleLine(item.promptPreview),
    assistant: singleLine(item.assistantPreview),
  };
}

export function minimapDestinationIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (count <= 0) {
    return null;
  }
  if (key === "ArrowDown") {
    return Math.min(count - 1, currentIndex + 1);
  }
  if (key === "ArrowUp") {
    return Math.max(0, currentIndex - 1);
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return count - 1;
  }
  return null;
}
