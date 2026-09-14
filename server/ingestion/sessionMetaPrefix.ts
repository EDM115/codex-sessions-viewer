import { lstat, open } from "node:fs/promises";

import * as z from "zod";

import {
  isoTimestampSchema,
  jsonValueSchema,
  type JsonValue,
} from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";

export interface SessionMetaPrefixObservation {
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  regular: boolean;
  symbolicLink: boolean;
}

export interface SessionMetaPrefixFile {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface SessionMetaPrefixOptions {
  /** Extend a truncated first record only, up to this total byte cap. */
  firstRecordMaxBytes?: number | undefined;
  openFile?: ((path: string) => Promise<SessionMetaPrefixFile>) | undefined;
  observeFile?: ((path: string) => Promise<SessionMetaPrefixObservation>) | undefined;
}

export interface SessionMetaPrefixGit {
  branch: string | null;
  commitHash: string | null;
  repositoryUrl: string | null;
}

export interface SessionMetaPrefix {
  id: string;
  parentThreadId: string | null;
  timestamp: string | null;
  cwd: string | null;
  source: JsonValue | null;
  modelProvider: string | null;
  git: SessionMetaPrefixGit | null;
}

export interface SessionMetaPrefixResult {
  status: "found" | "missing" | "changed" | "exhausted" | "incomplete" | "invalid";
  meta: SessionMetaPrefix | null;
  parentThreadIdHint: string | null;
  bytesRead: number;
  observation: SessionMetaPrefixObservation;
  diagnostics: ViewerDiagnostic[];
}

/** Catalog startup never reads an unbounded metadata record or a transcript fallback. */
export const CATALOG_METADATA_MAX_BYTES = 256 * 1024;
export const CATALOG_EVIDENCE_VERSION = 1;

export const sessionMetaEvidenceSchema = z.strictObject({
  version: z.int().positive(),
  origin: z.enum(["rollout-prefix", "materialized"]),
  status: z.enum(["found", "missing", "changed", "exhausted", "incomplete", "invalid"]),
  parentThreadIdHint: z.string().nullable(),
  meta: z
    .strictObject({
      id: z.string(),
      parentThreadId: z.string().nullable(),
      timestamp: z.string().nullable(),
      cwd: z.string().nullable(),
      source: jsonValueSchema.nullable(),
      modelProvider: z.string().nullable(),
      git: z
        .strictObject({
          branch: z.string().nullable(),
          commitHash: z.string().nullable(),
          repositoryUrl: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
});
export type SessionMetaEvidence = z.infer<typeof sessionMetaEvidenceSchema>;

const sessionMetaRecordSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string().min(1),
    parent_thread_id: z.string().min(1).nullable().optional(),
    timestamp: isoTimestampSchema.nullable().optional(),
    cwd: z.string().nullable().optional(),
    source: jsonValueSchema.nullable().optional(),
    model_provider: z.string().nullable().optional(),
    git: z
      .object({
        branch: z.string().nullable().optional(),
        commit_hash: z.string().nullable().optional(),
        repository_url: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});

export async function observeSessionMetaSource(
  path: string,
): Promise<SessionMetaPrefixObservation> {
  const stats = await lstat(path, { bigint: true });
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    regular: stats.isFile(),
    symbolicLink: stats.isSymbolicLink(),
  };
}

async function defaultOpenFile(path: string): Promise<SessionMetaPrefixFile> {
  return open(path, "r");
}

function sameObservation(
  left: SessionMetaPrefixObservation,
  right: SessionMetaPrefixObservation,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.regular === right.regular &&
    left.symbolicLink === right.symbolicLink
  );
}

function malformedMetaDiagnostic(path: string, line: number): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "source.invalid_jsonl",
    severity: "warning",
    area: "source",
    message: "A bounded rollout prefix contains malformed session metadata and was ignored.",
    path,
    details: { line },
  });
}

function parseCompleteLines(
  path: string,
  bytes: Buffer,
): { meta: SessionMetaPrefix | null; diagnostics: ViewerDiagnostic[] } {
  const finalLineFeed = bytes.lastIndexOf(0x0a);
  if (finalLineFeed < 0) {
    return { meta: null, diagnostics: [] };
  }
  const lines = bytes.subarray(0, finalLineFeed).toString("utf8").split("\n");
  const diagnostics: ViewerDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.includes('"session_meta"')) {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      diagnostics.push(malformedMetaDiagnostic(path, index + 1));
      continue;
    }
    const parsed = sessionMetaRecordSchema.safeParse(decoded);
    if (!parsed.success) {
      diagnostics.push(malformedMetaDiagnostic(path, index + 1));
      continue;
    }
    const git = parsed.data.payload.git;
    return {
      meta: {
        id: parsed.data.payload.id,
        parentThreadId: parsed.data.payload.parent_thread_id ?? null,
        timestamp: parsed.data.payload.timestamp ?? null,
        cwd: parsed.data.payload.cwd ?? null,
        source: parsed.data.payload.source ?? null,
        modelProvider: parsed.data.payload.model_provider ?? null,
        git:
          git === null || git === undefined
            ? null
            : {
                branch: git.branch ?? null,
                commitHash: git.commit_hash ?? null,
                repositoryUrl: git.repository_url ?? null,
              },
      },
      diagnostics,
    };
  }
  return { meta: null, diagnostics };
}

function parentThreadIdHint(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  const encoded = text.match(/(?<!\\)"parent_thread_id"\s*:\s*("(?:\\.|[^"\\])*")/u)?.[1];
  if (encoded === undefined) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(encoded);
    return typeof decoded === "string" && decoded.trim() !== "" ? decoded : null;
  } catch {
    return null;
  }
}

export async function readSessionMetaPrefix(
  path: string,
  maxBytes: number,
  options: SessionMetaPrefixOptions = {},
): Promise<SessionMetaPrefixResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new RangeError("maxBytes must be a safe integer between 1 and 1048576");
  }
  const observeFile = options.observeFile ?? observeSessionMetaSource;
  const openFile = options.openFile ?? defaultOpenFile;
  const before = await observeFile(path);
  if (!before.regular || before.symbolicLink) {
    throw new Error(`Expected a regular rollout file: ${path}`);
  }
  const requested = Math.min(maxBytes, Number(before.size));
  const cap = options.firstRecordMaxBytes ?? maxBytes;
  if (!Number.isSafeInteger(cap) || cap < maxBytes || cap > 1024 * 1024) {
    throw new RangeError("firstRecordMaxBytes must be between maxBytes and 1048576");
  }
  const buffer = Buffer.allocUnsafe(Math.min(cap, Number(before.size)));
  const handle = await openFile(path);
  let bytesRead = 0;
  try {
    if (requested > 0) {
      bytesRead = (await handle.read(buffer, 0, requested, 0)).bytesRead;
    }
    // Extend only while the first physical record is unfinished. Short reads are retried.
    while (bytesRead < buffer.length && buffer.subarray(0, bytesRead).indexOf(0x0a) < 0) {
      const length = Math.min(maxBytes, buffer.length - bytesRead);
      // oxlint-disable-next-line no-await-in-loop -- Sequential bounded reads stop at the first record boundary.
      const result = await handle.read(buffer, bytesRead, length, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  const parsed = parseCompleteLines(path, buffer.subarray(0, bytesRead));
  const parentHint =
    parsed.meta?.parentThreadId ?? parentThreadIdHint(buffer.subarray(0, bytesRead));
  const after = await observeFile(path);
  if (!sameObservation(before, after)) {
    return {
      status: "changed",
      meta: null,
      parentThreadIdHint: null,
      bytesRead,
      observation: after,
      diagnostics: [],
    };
  }
  const exhausted =
    parsed.meta === null &&
    bytesRead < Number(before.size) &&
    buffer.subarray(0, bytesRead).indexOf(0x0a) < 0;
  if (exhausted) {
    parsed.diagnostics.push(
      createViewerDiagnostic({
        code: "source.metadata_budget_exhausted",
        severity: "info",
        area: "source",
        path,
        message:
          "Session metadata exceeds the bounded catalog read; its relationship is unresolved until complete evidence is available.",
        details: { maxBytes: cap, bytesRead },
      }),
    );
  }
  return {
    status:
      parsed.meta !== null
        ? "found"
        : exhausted
          ? "exhausted"
          : parsed.diagnostics.length > 0
            ? "invalid"
            : buffer.subarray(0, bytesRead).indexOf(0x0a) < 0 && bytesRead > 0
              ? bytesRead < Number(before.size)
                ? "exhausted"
                : "incomplete"
              : "missing",
    meta: parsed.meta,
    parentThreadIdHint: parentHint,
    bytesRead,
    observation: before,
    diagnostics: parsed.diagnostics,
  };
}
