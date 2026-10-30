import type { SessionIndexEntry } from "#server/metadata/sessionIndex.ts";
import type { StateThreadMetadata } from "#server/metadata/stateSnapshot.ts";

type Field = { value: string | null; source: string | null };
function choose(...candidates: readonly Field[]): Field {
  return candidates.find((candidate) => candidate.value !== null) ?? { value: null, source: null };
}
function text(value: string | null | undefined, source: string): Field {
  return { value: value?.trim() || null, source };
}
function timestamp(
  milliseconds: number | null | undefined,
  seconds: number | null | undefined,
  field: string,
): Field {
  const value = milliseconds ?? (seconds == null ? null : seconds * 1000);
  if (value === null || !Number.isFinite(value)) {
    return { value: null, source: null };
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? { value: date.toISOString(), source: `native.${field}${milliseconds == null ? "" : "Ms"}` }
    : { value: null, source: null };
}

export function resolveThreadFields(options: {
  id: string;
  thread?: StateThreadMetadata | null | undefined;
  index?: SessionIndexEntry | undefined;
  knownTitle?: string | undefined;
  historyMode?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  recencyAt?: string | null | undefined;
  createdAtSource?: string | undefined;
  updatedAtSource?: string | undefined;
  recencyAtSource?: string | undefined;
}) {
  const { thread, index } = options;
  const paginated = (thread?.historyMode ?? options.historyMode) === "paginated";
  const title = choose(
    text(thread?.name, "native.name"),
    text(paginated ? thread?.title : null, "native.title"),
    text(paginated ? null : index?.threadName, "session-index.name"),
    text(thread?.title, "native.title"),
    text(options.knownTitle === options.id ? null : options.knownTitle, "retained.title"),
    text(options.id, "thread.id"),
  );
  const createdAt = choose(
    timestamp(thread?.createdAtMs, thread?.createdAt, "createdAt"),
    text(options.createdAt, options.createdAtSource ?? "retained.createdAt"),
  );
  const updatedAt = choose(
    timestamp(thread?.updatedAtMs, thread?.updatedAt, "updatedAt"),
    text(index?.updatedAt, "session-index.updatedAt"),
    text(options.updatedAt, options.updatedAtSource ?? "retained.updatedAt"),
  );
  const recencyAt = choose(
    timestamp(thread?.recencyAtMs, thread?.recencyAt, "recencyAt"),
    text(thread ? null : options.recencyAt, options.recencyAtSource ?? "retained.recencyAt"),
    updatedAt,
  );
  const metadataConflicts: Array<"title" | "updatedAt"> = [];
  if (
    index?.threadName?.trim() &&
    title.source?.startsWith("native.") &&
    index.threadName.trim() !== title.value
  ) {
    metadataConflicts.push("title");
  }
  if (
    index?.updatedAt &&
    updatedAt.source?.startsWith("native.") &&
    index.updatedAt !== updatedAt.value
  ) {
    metadataConflicts.push("updatedAt");
  }
  return {
    title: title.value!,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    recencyAt: recencyAt.value,
    fieldSources: {
      title: title.source!,
      createdAt: createdAt.value === null ? null : createdAt.source,
      updatedAt: updatedAt.value === null ? null : updatedAt.source,
      recencyAt: recencyAt.value === null ? null : recencyAt.source,
    },
    metadataConflicts,
  };
}
import { createHash } from "node:crypto";

import {
  catalogSessionMetadataSchema,
  type CatalogSessionMetadata,
} from "#shared/types/library.ts";

export function catalogMetadataRevision(metadata: CatalogSessionMetadata): string {
  const {
    revision: _sourceRevision,
    metadataRevision: _metadataRevision,
    ...fields
  } = catalogSessionMetadataSchema.parse(metadata);
  return `metadata-v1:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}
