import { lstat, open } from "node:fs/promises";

import * as z from "zod";

import { rawThreadStructureSchema } from "#server/metadata/rawThreadMetadata.ts";
import {
  isoTimestampSchema,
  jsonValueSchema,
  type JsonValue,
  rolloutHistoryBaseSchema,
  type RolloutHistoryBase,
} from "#shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "#shared/types/diagnostics.ts";
import { threadClassificationSchema } from "#shared/types/library.ts";

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
  rootSessionId?: string | null;
  historyBase?: RolloutHistoryBase | null;
  subagentHistoryStartOrdinal?: number | null;
  forkedFromId?: string | null;
  forkedFromOrdinalExclusive?: number | null;
  attachedThread?: JsonValue | null;
  historyMode?: string | null;
  threadSource?: string | null;
  ephemeral?: boolean | null;
  agentPath?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  attachedParentThreadId?: string | null;
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
export const CATALOG_EVIDENCE_VERSION = 2;

export const sessionMetaEvidenceSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    classification: threadClassificationSchema.optional(),
    origin: z.enum(["rollout-prefix", "materialized", "native-metadata", "session-index"]),
    freshness: z.enum(["verified", "retained-unvalidated"]).optional(),
    validatedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    status: z.enum(["found", "missing", "changed", "exhausted", "incomplete", "invalid"]),
    parentThreadIdHint: z.string().nullable(),
    meta: z
      .strictObject({
        id: z.string(),
        rootSessionId: z.string().nullable().optional(),
        historyBase: rolloutHistoryBaseSchema.nullable().optional(),
        subagentHistoryStartOrdinal: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .nullable()
          .optional(),
        forkedFromId: z.string().nullable().optional(),
        forkedFromOrdinalExclusive: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .nullable()
          .optional(),
        attachedThread: jsonValueSchema.nullable().optional(),
        historyMode: z.string().nullable().optional(),
        threadSource: z.string().nullable().optional(),
        ephemeral: z.boolean().nullable().optional(),
        agentPath: z.string().nullable().optional(),
        agentNickname: z.string().nullable().optional(),
        agentRole: z.string().nullable().optional(),
        attachedParentThreadId: z.string().nullable().optional(),
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
  })
  .superRefine((evidence, context) => {
    if (evidence.status === "found" && evidence.meta === null) {
      context.addIssue({
        code: "custom",
        path: ["meta"],
        message: "Found evidence requires metadata",
      });
    }
  });
export type SessionMetaEvidence = z.infer<typeof sessionMetaEvidenceSchema>;

const sessionMetaRecordSchema = z.object({
  type: z.literal("session_meta"),
  payload: z
    .object({
      id: z.string().min(1),
      session_id: z.string().min(1).nullable().optional(),
      history_base: z
        .object({
          thread_id: z.string().min(1),
          end_ordinal_exclusive: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER - 1),
          end_byte_offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .nullable()
        .optional(),
      subagent_history_start_ordinal: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .nullable()
        .optional(),
      forked_from_id: z.string().min(1).nullable().optional(),
      forked_from_ordinal_exclusive: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .nullable()
        .optional(),
      attached_thread: jsonValueSchema.nullable().optional(),
      history_mode: z.string().nullable().optional(),
      thread_source: z.string().nullable().optional(),
      threadSource: z.string().nullable().optional(),
      ephemeral: z.boolean().nullable().optional(),
      agent_path: z.string().nullable().optional(),
      agentPath: z.string().nullable().optional(),
      agent_nickname: z.string().nullable().optional(),
      agentNickname: z.string().nullable().optional(),
      agent_role: z.string().nullable().optional(),
      agentRole: z.string().nullable().optional(),
      attached_parent_thread_id: z.string().nullable().optional(),
      attachedParentThreadId: z.string().nullable().optional(),
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
    })
    .and(rawThreadStructureSchema),
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

export function parseSessionMetaBytes(
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
        rootSessionId: parsed.data.payload.session_id ?? null,
        historyBase:
          parsed.data.payload.history_base == null
            ? null
            : {
                physicalRolloutId: parsed.data.payload.history_base.thread_id,
                endOrdinalExclusive: parsed.data.payload.history_base.end_ordinal_exclusive,
                endByteOffset: parsed.data.payload.history_base.end_byte_offset,
              },
        subagentHistoryStartOrdinal: parsed.data.payload.subagent_history_start_ordinal ?? null,
        forkedFromId: parsed.data.payload.forked_from_id ?? null,
        forkedFromOrdinalExclusive: parsed.data.payload.forked_from_ordinal_exclusive ?? null,
        attachedThread: parsed.data.payload.attached_thread ?? null,
        historyMode: parsed.data.payload.history_mode ?? null,
        threadSource: parsed.data.payload.thread_source ?? parsed.data.payload.threadSource ?? null,
        ephemeral: parsed.data.payload.ephemeral ?? null,
        agentPath: parsed.data.payload.agent_path ?? parsed.data.payload.agentPath ?? null,
        agentNickname:
          parsed.data.payload.agent_nickname ?? parsed.data.payload.agentNickname ?? null,
        agentRole: parsed.data.payload.agent_role ?? parsed.data.payload.agentRole ?? null,
        attachedParentThreadId:
          parsed.data.payload.attached_parent_thread_id ??
          parsed.data.payload.attachedParentThreadId ??
          null,
        parentThreadId:
          parsed.data.payload.parent_thread_id ?? parsed.data.payload.parentThreadId ?? null,
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
  const parsed = parseSessionMetaBytes(path, buffer.subarray(0, bytesRead));
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
