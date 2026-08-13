import * as z from "zod";

import { isoTimestampSchema } from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import { partitionJsonlTail, readStableBytes } from "../ingestion/stableRead.ts";

const sessionIndexRecordSchema = z.object({
  id: z.string().min(1),
  thread_name: z.string().nullable().optional(),
  updated_at: isoTimestampSchema,
});

export interface SessionIndexEntry {
  id: string;
  threadName: string | null;
  updatedAt: string;
}

export interface SessionIndexResult {
  entries: SessionIndexEntry[];
  pending: Buffer;
  diagnostics: ViewerDiagnostic[];
}

function invalidRecord(path: string, line: number): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "source.invalid_jsonl",
    severity: "warning",
    area: "metadata",
    message: "A session-index record is malformed and was skipped.",
    path,
    details: { line },
  });
}

export async function readSessionIndex(path: string): Promise<SessionIndexResult> {
  const stable = await readStableBytes(path);
  if (stable.read.status !== "stable") {
    return {
      entries: [],
      pending: Buffer.alloc(0),
      diagnostics: [
        createViewerDiagnostic({
          code: "source.changed_during_read",
          severity: "warning",
          area: "metadata",
          message: "The session index changed while it was being read and will be retried.",
          path,
        }),
      ],
    };
  }

  const { complete, pending } = partitionJsonlTail(stable.bytes);
  const latest = new Map<string, SessionIndexEntry>();
  const diagnostics: ViewerDiagnostic[] = [];
  const lines = complete.toString("utf8").split("\n");

  lines.forEach((line, index) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") {
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      diagnostics.push(invalidRecord(path, index + 1));
      return;
    }
    const parsed = sessionIndexRecordSchema.safeParse(decoded);
    if (!parsed.success) {
      diagnostics.push(invalidRecord(path, index + 1));
      return;
    }

    const candidate: SessionIndexEntry = {
      id: parsed.data.id,
      threadName: parsed.data.thread_name?.trim() || null,
      updatedAt: parsed.data.updated_at,
    };
    const previous = latest.get(candidate.id);
    const candidateIsNewer =
      previous === undefined || Date.parse(candidate.updatedAt) >= Date.parse(previous.updatedAt);
    const preservesNonEmptyName = candidate.threadName !== null || previous?.threadName === null;
    if (candidateIsNewer && preservesNonEmptyName) {
      latest.set(candidate.id, candidate);
    }
  });

  return {
    entries: [...latest.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    pending,
    diagnostics,
  };
}
