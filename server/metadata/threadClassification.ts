import {
  visibleRoles,
  type ThreadVisibilityPurpose,
} from "../../shared/library/threadVisibility.ts";
export {
  isThreadVisible,
  type ThreadVisibilityPurpose,
} from "../../shared/library/threadVisibility.ts";
import { resolve } from "node:path";

import type { JsonValue } from "../../shared/types/conversation.ts";
import { type ThreadClassification } from "../../shared/types/library.ts";
import { sessionMetaEvidenceSchema } from "../ingestion/sessionMetaPrefix.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";
import {
  decodeThreadSource,
  rawThreadMetadata,
  type RawThreadMetadataResult,
} from "./rawThreadMetadata.ts";
export { rawThreadMetadata } from "./rawThreadMetadata.ts";

export interface CatalogThreadMetadata {
  source?: JsonValue | undefined;
  threadSource?: string | null | undefined;
  ephemeral?: boolean | null | undefined;
  historyMode?: string | null | undefined;
  parentThreadId?: string | null | undefined;
  attachedParentThreadId?: string | null | undefined;
  forkedFromId?: string | null | undefined;
  attachedThread?: JsonValue | undefined;
  agentPath?: string | null | undefined;
  agentNickname?: string | null | undefined;
  agentRole?: string | null | undefined;
  rolloutPath?: string | undefined;
}
export interface ThreadStructureEvidence {
  spawnParentThreadId?: string | null;
  spawnParentThreadIds?: readonly string[];
  parentThreadIdHint?: string | null | undefined;
  conflictingThreadSource?: string | null;
  invalidMetadata?: boolean;
}
function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
export const parseThreadSource = decodeThreadSource;
const internalRoles = new Set([
  "guardian_review",
  "security_scan",
  "internal",
  "guardian",
  "review",
  "compact",
]);
type Declaration = NonNullable<ThreadClassification["declarations"]>[number];
interface StructuralFacet {
  metadata: CatalogThreadMetadata;
  declaration: Declaration;
  transport: string | null;
  attachedParent: string | null;
  hasAttachment: boolean;
  hasFork: boolean;
  unknown: boolean;
  agentPath: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  agentDepth: number | null;
}
function structuralFacet(
  metadata: CatalogThreadMetadata,
  origin: Declaration["origin"],
  status: Declaration["status"] = "valid",
  issues: string[] = [],
): StructuralFacet {
  const source = decodeThreadSource(metadata.source);
  const sourceRecord = record(source);
  const subagent = sourceRecord?.["subagent"] ?? sourceRecord?.["subAgent"];
  const sub = record(subagent);
  const spawn = record(sub?.["thread_spawn"] ?? sub?.["threadSpawn"]);
  const attached = record(metadata.attachedThread);
  const attachedParent =
    metadata.attachedParentThreadId ??
    text(attached?.["parent_thread_id"] ?? attached?.["parentThreadId"]);
  const parentThreadIds = [
    ...new Set(
      [
        metadata.parentThreadId,
        text(spawn?.["parent_thread_id"]),
        text(spawn?.["parentThreadId"]),
        text(sub?.["parent_thread_id"]),
        text(sub?.["parentThreadId"]),
      ].filter((value): value is string => typeof value === "string" && value.trim() !== ""),
    ),
  ];
  const helper = subagent !== undefined && spawn === null;
  const internal = helper || internalRoles.has(metadata.threadSource ?? "");
  const hasAttachment = attachedParent !== null || metadata.attachedThread != null;
  const hasFork = metadata.forkedFromId != null;
  const depth = spawn?.["depth"];
  return {
    metadata,
    declaration: {
      origin,
      source: metadata.source ?? null,
      threadSource: metadata.threadSource ?? null,
      parentThreadIds,
      spawn: spawn !== null,
      internal,
      ephemeral: metadata.ephemeral ?? null,
      status,
      issues,
    },
    transport: typeof source === "string" ? source : null,
    attachedParent,
    hasAttachment,
    hasFork,
    unknown:
      (metadata.threadSource != null &&
        metadata.threadSource !== "user" &&
        !internalRoles.has(metadata.threadSource)) ||
      (sourceRecord !== null && subagent === undefined) ||
      (source !== null && typeof source !== "string" && sourceRecord === null),
    agentPath: metadata.agentPath ?? text(spawn?.["agent_path"] ?? spawn?.["agentPath"]),
    agentNickname:
      metadata.agentNickname ?? text(spawn?.["agent_nickname"] ?? spawn?.["agentNickname"]),
    agentRole: metadata.agentRole ?? text(spawn?.["agent_role"] ?? spawn?.["agentRole"]),
    agentDepth:
      typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0 ? depth : null,
  };
}
function classifyFacets(
  facets: StructuralFacet[],
  evidence: ThreadStructureEvidence,
): ThreadClassification {
  const declarations = facets.map((facet) => facet.declaration);
  const edges = [
    ...new Set(
      [evidence.spawnParentThreadId, ...(evidence.spawnParentThreadIds ?? [])].filter(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      ),
    ),
  ];
  for (const parent of edges) {
    declarations.push({
      origin: "spawn-edge",
      source: null,
      threadSource: null,
      parentThreadIds: [parent],
      spawn: true,
      internal: false,
      ephemeral: null,
      status: "valid",
      issues: [],
    });
  }
  const parents = [...new Set(declarations.flatMap((declaration) => declaration.parentThreadIds))];
  const roles = [
    ...new Set(
      [
        ...declarations.map((declaration) => declaration.threadSource),
        evidence.conflictingThreadSource,
      ].filter((value): value is string => typeof value === "string"),
    ),
  ];
  const ephemeralStates = new Set(
    declarations.map((declaration) => declaration.ephemeral).filter((value) => value !== null),
  );
  const internal = declarations.some((declaration) => declaration.internal);
  const ephemeral =
    facets.find((facet) => facet.metadata.ephemeral != null)?.metadata.ephemeral ?? null;
  const hasExplicitSpawn = declarations.some((declaration) => declaration.spawn);
  const hasAttachment = facets.some((facet) => facet.hasAttachment);
  const hasFork = facets.some((facet) => facet.hasFork);
  const hasSpawn =
    hasExplicitSpawn || (parents.length > 0 && !internal && !hasAttachment && !hasFork);
  const relationship = hasSpawn ? "spawn" : hasAttachment ? "attached" : hasFork ? "fork" : "none";
  const reasons: string[] = [];
  let visibility: ThreadClassification["visibility"];
  if (
    evidence.invalidMetadata === true ||
    declarations.some((declaration) => declaration.status === "invalid")
  ) {
    visibility = "unresolved";
    reasons.push("invalid-structural-metadata");
  } else if (roles.length > 1 || (roles.includes("user") && internal) || ephemeralStates.size > 1) {
    visibility = "unresolved";
    reasons.push("conflicting-structural-evidence");
  } else if (parents.length > 1) {
    visibility = "unresolved";
    reasons.push("conflicting-parent-evidence");
  } else if (facets.some((facet) => facet.unknown)) {
    visibility = "unresolved";
    reasons.push("unknown-structural-source");
  } else if (hasSpawn && parents.length === 0) {
    visibility = "unresolved";
    reasons.push("missing-spawn-parent");
  } else if (internal || ephemeral === true) {
    visibility = "internal";
    reasons.push(ephemeral === true ? "ephemeral-thread" : "internal-helper");
  } else if (hasSpawn) {
    visibility = "delegated-child";
    reasons.push(hasExplicitSpawn ? "declared-spawn" : "legacy-flat-parent-delegation");
  } else if (roles.includes("user")) {
    visibility = "user-root";
    reasons.push("explicit-user-thread");
  } else {
    visibility = "user-root";
    reasons.push("legacy-absent-role-compatible-root");
  }
  return {
    visibility,
    transportSource: facets.find((facet) => facet.transport !== null)?.transport ?? null,
    threadSource:
      facets.find((facet) => facet.metadata.threadSource != null)?.metadata.threadSource ?? null,
    ephemeral,
    historyMode:
      facets.find((facet) => facet.metadata.historyMode != null)?.metadata.historyMode ?? null,
    relationship,
    parentThreadId:
      parents.length === 1
        ? parents[0]!
        : parents.length > 1
          ? null
          : internal
            ? (evidence.parentThreadIdHint ?? null)
            : null,
    attachedParentThreadId:
      facets.find((facet) => facet.attachedParent !== null)?.attachedParent ?? null,
    agentPath: facets.find((facet) => facet.agentPath !== null)?.agentPath ?? null,
    agentNickname: facets.find((facet) => facet.agentNickname !== null)?.agentNickname ?? null,
    agentRole: facets.find((facet) => facet.agentRole !== null)?.agentRole ?? null,
    agentDepth: facets.find((facet) => facet.agentDepth !== null)?.agentDepth ?? null,
    reasons,
    declarations,
  };
}
export function classifyCatalogThread(
  thread: CatalogThreadMetadata,
  evidence: ThreadStructureEvidence = {},
): ThreadClassification {
  return classifyFacets([structuralFacet(thread, "metadata")], evidence);
}
export function classifyThreadMetadata(
  raw: RawThreadMetadataResult,
  native?: CatalogThreadMetadata,
  evidence: ThreadStructureEvidence = {},
): ThreadClassification {
  return classifyFacets(
    [
      ...(native === undefined ? [] : [structuralFacet(native, "native")]),
      structuralFacet(raw.metadata ?? {}, "raw", raw.status, raw.issues),
    ],
    evidence,
  );
}
export function catalogVisibilitySql(purpose: ThreadVisibilityPurpose, alias = ""): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  const role = `viewer_thread_visibility(${prefix}structural_evidence_json, ${prefix}session_kind)`;
  return `${role} IN (${visibleRoles[purpose].map((value) => `'${value}'`).join(", ")})`;
}
export function cachedThreadClassification(evidence: unknown, kind: string): ThreadClassification {
  const baseline = classifyCatalogThread({});
  const invalid = {
    ...baseline,
    visibility: "unresolved" as const,
    reasons: ["invalid-classification-evidence"],
  };
  if (evidence === null || evidence === undefined) {
    return {
      ...baseline,
      visibility:
        kind === "root" ? "user-root" : kind === "subagent" ? "delegated-child" : "internal",
      reasons: ["legacy-catalog-kind"],
    };
  }
  const envelope = sessionMetaEvidenceSchema.safeParse(evidence);
  if (!envelope.success) {
    return invalid;
  }
  if (envelope.data.status === "invalid") {
    return envelope.data.classification?.visibility === "unresolved"
      ? envelope.data.classification
      : invalid;
  }
  if (envelope.data.classification !== undefined) {
    return envelope.data.classification;
  }
  return envelope.data.version === 1 ? cachedThreadClassification(null, kind) : invalid;
}
export function classificationKind(
  classification: ThreadClassification,
): "root" | "subagent" | "auxiliary" {
  return classification.visibility === "user-root"
    ? "root"
    : classification.visibility === "delegated-child"
      ? "subagent"
      : "auxiliary";
}

export function classifyNormalizedSession(
  session: NormalizedSession,
  native?: CatalogThreadMetadata,
  evidence: ThreadStructureEvidence = {},
): ThreadClassification {
  if (native === undefined && session.classification !== undefined) {
    return session.classification;
  }
  const pathKey = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const current =
    !native?.rolloutPath || pathKey(native.rolloutPath) === pathKey(session.summary.sourcePath);
  const raw = current ? rawThreadMetadata(normalizedSessionMeta(session)) : rawThreadMetadata(null);
  if (raw.status === "missing" && current && session.summary.parentThreadId !== null) {
    raw.metadata = { parentThreadId: session.summary.parentThreadId };
  }
  const classification = classifyThreadMetadata(raw, native, evidence);
  if (!current) {
    classification.reasons.push("stale-rollout-structure-ignored");
  }
  return classification;
}
export function normalizedSessionMeta(session: NormalizedSession): unknown {
  const selectedEvent = session.rawEvents.findLast((event) => {
    const envelope = record(event.payload);
    const payload = record(envelope?.["payload"]) ?? envelope;
    return event.type === "session_meta" && payload?.["id"] === session.summary.id;
  });
  const envelope = record(selectedEvent?.payload);
  return record(envelope?.["payload"]) ?? envelope;
}
