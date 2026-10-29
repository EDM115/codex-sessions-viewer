import type { LogicalVisibility, ReviewSourceRecord } from "../types/history.ts";

/** Explicit contextOnly decisions come from the full logical-lineage reader */
export function logicalRecordVisibility(input: {
  contextOnly?: boolean;
  ordinal: number | null;
  bodyStartOrdinal: number;
  displayStartOrdinal: number;
}): LogicalVisibility {
  if (input.contextOnly !== undefined) {
    return input.contextOnly ? "context-only" : "visible";
  }
  if (input.displayStartOrdinal > input.bodyStartOrdinal && input.ordinal === null) {
    return "unresolved";
  }
  return input.ordinal !== null && input.ordinal < input.displayStartOrdinal
    ? "context-only"
    : "visible";
}
export function unverifiedReviewRecord(record: ReviewSourceRecord): ReviewSourceRecord {
  return {
    ...record,
    logicalVisibility: record.logicalVisibility === "context-only" ? "context-only" : "unresolved",
  };
}
