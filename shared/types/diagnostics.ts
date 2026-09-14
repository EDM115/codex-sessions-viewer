import * as z from "zod";

import { isoTimestampSchema, jsonValueSchema, type JsonObject } from "./conversation.ts";

export type ViewerDiagnosticCode =
  | "config.invalid_json"
  | "config.invalid_settings"
  | "config.unreadable"
  | "config.write_failed"
  | "codex_home.missing"
  | "codex_home.not_directory"
  | "codex_home.unreadable"
  | "source.changed_during_read"
  | "source.duplicate_session"
  | "source.invalid_jsonl"
  | "source.metadata_budget_exhausted"
  | "metadata.snapshot_invalid"
  | "cache.unavailable";

export type ViewerDiagnosticSeverity = "info" | "warning" | "error";
export type ViewerDiagnosticArea = "config" | "source" | "metadata" | "cache" | "export";

export interface ViewerDiagnostic {
  id: string;
  code: ViewerDiagnosticCode;
  severity: ViewerDiagnosticSeverity;
  area: ViewerDiagnosticArea;
  message: string;
  path: string | null;
  sessionId: string | null;
  recoverable: boolean;
  createdAt: string;
  details: JsonObject;
}

export interface CreateViewerDiagnosticInput {
  code: ViewerDiagnosticCode;
  severity: ViewerDiagnosticSeverity;
  area: ViewerDiagnosticArea;
  message: string;
  path?: string | null | undefined;
  sessionId?: string | null | undefined;
  recoverable?: boolean | undefined;
  createdAt?: string | undefined;
  details?: JsonObject | undefined;
}

export const viewerDiagnosticCodeSchema = z.enum([
  "config.invalid_json",
  "config.invalid_settings",
  "config.unreadable",
  "config.write_failed",
  "codex_home.missing",
  "codex_home.not_directory",
  "codex_home.unreadable",
  "source.changed_during_read",
  "source.duplicate_session",
  "source.invalid_jsonl",
  "source.metadata_budget_exhausted",
  "metadata.snapshot_invalid",
  "cache.unavailable",
]);

export const viewerDiagnosticSchema = z.strictObject({
  id: z.string().min(1),
  code: viewerDiagnosticCodeSchema,
  severity: z.enum(["info", "warning", "error"]),
  area: z.enum(["config", "source", "metadata", "cache", "export"]),
  message: z.string().min(1),
  path: z.string().nullable(),
  sessionId: z.string().nullable(),
  recoverable: z.boolean(),
  createdAt: isoTimestampSchema,
  details: z.record(z.string(), jsonValueSchema),
});

export function createViewerDiagnostic(input: CreateViewerDiagnosticInput): ViewerDiagnostic {
  const path = input.path ?? null;
  const sessionId = input.sessionId ?? null;

  return viewerDiagnosticSchema.parse({
    id: `${input.code}:${path ?? sessionId ?? "viewer"}`,
    code: input.code,
    severity: input.severity,
    area: input.area,
    message: input.message,
    path,
    sessionId,
    recoverable: input.recoverable ?? true,
    createdAt: input.createdAt ?? new Date().toISOString(),
    details: input.details ?? {},
  });
}
