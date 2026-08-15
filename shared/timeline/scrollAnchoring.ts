export interface ScrollAnchorPosition {
  top: number;
}

export function scrollAnchorAdjustment(
  before: ScrollAnchorPosition,
  after: ScrollAnchorPosition,
): number {
  return after.top - before.top;
}

export function shouldAdjustForMeasuredRow(
  row: { end: number },
  scrollOffset: number | null,
): boolean {
  return scrollOffset !== null && row.end < scrollOffset;
}
