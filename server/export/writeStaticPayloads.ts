import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type {
  ConversationActivity,
  ConversationMessage,
  ConversationScope,
  ConversationTurn,
  JsonValue,
  TurnNavigatorItem,
} from "../../shared/types/conversation.ts";
import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { InspectorRecord, InspectorTarget, TurnChunk } from "../../shared/types/repository.ts";
import type { NormalizedRawEvent, NormalizedSession } from "../normalization/normalizeSession.ts";
import { assertSafeOutputComponent, serializedJson, writeOutputFile } from "./outputFiles.ts";

const DEFAULT_CHUNK_SIZE = 20;

export interface WriteStaticPayloadOptions {
  generatedRoot: string;
  publicRoot?: string | undefined;
  chunkSize?: number | undefined;
  writeIndex?: boolean | undefined;
  writeSessions?: boolean | undefined;
  diagnosticsBySession?: ReadonlyMap<string, readonly ViewerDiagnostic[]> | undefined;
}

export interface WriteStaticPayloadResult {
  sessionCount: number;
  turnChunkCount: number;
  writtenFileCount: number;
  reusedFileCount: number;
  published: boolean;
}

export interface ReconcileStaticArtifactsOptions {
  completeReconciliation: boolean;
}

export interface PublishCachedContentOptions {
  generatedRoot: string;
  publicRoot?: string | undefined;
  assetIds: ReadonlySet<string>;
  faviconOrigins: ReadonlySet<string>;
}

export interface PublishCachedContentResult {
  assetCount: number;
  faviconCount: number;
  failedCount: number;
}

function preview(value: string, maximum: number): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1).trimEnd()}…`;
}

function proseLengthBucket(turn: ConversationTurn): 1 | 2 | 3 | 4 {
  const length =
    (turn.userMessage?.sourceMarkdown.length ?? 0) +
    turn.assistantMessages.reduce((total, message) => total + message.sourceMarkdown.length, 0);
  if (length <= 280) {
    return 1;
  }
  if (length <= 1_000) {
    return 2;
  }
  if (length <= 3_000) {
    return 3;
  }
  return 4;
}

function navigatorItem(turn: ConversationTurn): TurnNavigatorItem {
  return {
    turnId: turn.id,
    index: turn.index,
    userMessageId: turn.userMessage?.id ?? null,
    promptPreview: preview(turn.userMessage?.sourceMarkdown ?? "", 160),
    assistantPreview: preview(turn.assistantMessages[0]?.sourceMarkdown ?? "", 320),
    proseLengthBucket: proseLengthBucket(turn),
    createdAt: turn.userMessage?.createdAt ?? turn.startedAt,
  };
}

function rawRecord(event: NormalizedRawEvent): JsonValue {
  return {
    id: event.id,
    turnId: event.turnId,
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload,
  };
}

function relatedRawRecords(
  eventIds: readonly string[],
  rawEvents: ReadonlyMap<string, NormalizedRawEvent>,
): JsonValue[] {
  return eventIds
    .map((id) => rawEvents.get(id))
    .filter((event): event is NormalizedRawEvent => event !== undefined)
    .map(rawRecord);
}

function targetRecord(
  turn: ConversationTurn,
  target: InspectorTarget,
  input: {
    phase: string | null;
    createdAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    eventIds: string[];
    activityIds: string[];
  },
  rawEvents: ReadonlyMap<string, NormalizedRawEvent>,
): InspectorRecord {
  return {
    sessionId: turn.sessionId,
    target,
    models: turn.models,
    reasoningEfforts: turn.reasoningEfforts,
    phase: input.phase,
    createdAt: input.createdAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    timeToFirstTokenMs: target.type === "activity" ? null : turn.timeToFirstTokenMs,
    tokenDelta: target.type === "activity" ? null : turn.tokenDelta,
    toolCounts: turn.toolCounts,
    activityIds: input.activityIds,
    eventIds: input.eventIds,
    diagnosticIds: turn.diagnosticIds,
    rawRecords: relatedRawRecords(input.eventIds, rawEvents),
  };
}

function turnEventIds(turn: ConversationTurn): string[] {
  return [
    ...new Set([
      ...(turn.userMessage?.rawEventIds ?? []),
      ...turn.assistantMessages.flatMap(({ rawEventIds }) => rawEventIds),
      ...turn.activities.flatMap(({ rawEventIds }) => rawEventIds),
    ]),
  ];
}

function messageInspector(
  turn: ConversationTurn,
  message: ConversationMessage,
  rawEvents: ReadonlyMap<string, NormalizedRawEvent>,
): InspectorRecord {
  return targetRecord(
    turn,
    { type: "message", id: message.id },
    {
      phase: message.phase,
      createdAt: message.createdAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      eventIds: message.rawEventIds,
      activityIds: turn.activities.map(({ id }) => id),
    },
    rawEvents,
  );
}

function activityTiming(activity: ConversationActivity): {
  completedAt: string | null;
  durationMs: number | null;
} {
  return activity.kind === "tool"
    ? { completedAt: activity.completedAt, durationMs: activity.durationMs }
    : { completedAt: null, durationMs: null };
}

function inspectorsForTurn(
  turn: ConversationTurn,
  rawEvents: ReadonlyMap<string, NormalizedRawEvent>,
): InspectorRecord[] {
  return [
    targetRecord(
      turn,
      { type: "turn", id: turn.id },
      {
        phase: null,
        createdAt: turn.startedAt,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
        eventIds: turnEventIds(turn),
        activityIds: turn.activities.map(({ id }) => id),
      },
      rawEvents,
    ),
    ...(turn.userMessage === null ? [] : [messageInspector(turn, turn.userMessage, rawEvents)]),
    ...turn.assistantMessages.map((message) => messageInspector(turn, message, rawEvents)),
    ...turn.activities.map((activity) => {
      const timing = activityTiming(activity);
      return targetRecord(
        turn,
        { type: "activity", id: activity.id },
        {
          phase: null,
          createdAt: activity.createdAt,
          completedAt: timing.completedAt,
          durationMs: timing.durationMs,
          eventIds: activity.rawEventIds,
          activityIds: [activity.id],
        },
        rawEvents,
      );
    }),
  ];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function reconcileSessionChunks(
  root: string,
  sessionId: string,
  chunkCount: number,
): Promise<void> {
  const directory = join(root, "payloads", "sessions", sessionId);
  const expected = new Set(
    Array.from({ length: chunkCount }, (_, index) => [
      `turn-${index}.json`,
      `inspector-${index}.json`,
    ]).flat(),
  );
  const entries = await readdir(directory);
  for (const entry of entries.toSorted()) {
    if (!/^(?:inspector|turn)-\d+\.json$/u.test(entry) || expected.has(entry)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Only proven obsolete viewer-owned chunks are removed after replacement writes succeed.
    await safeRemoveGenerated(join(directory, entry), "file");
  }
}

async function writePayload(
  options: WriteStaticPayloadOptions,
  segments: readonly string[],
  value: unknown,
): Promise<Array<"written" | "reused">> {
  const bytes = serializedJson(value);
  const dispositions = [
    await writeOutputFile(options.generatedRoot, ["payloads", ...segments], bytes),
  ];
  if (options.publicRoot !== undefined) {
    dispositions.push(await writeOutputFile(options.publicRoot, ["payloads", ...segments], bytes));
  }
  return dispositions;
}

export async function writeStaticPayloads(
  conversations: readonly NormalizedSession[],
  options: WriteStaticPayloadOptions,
): Promise<WriteStaticPayloadResult> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 200) {
    throw new RangeError("Static payload chunk size must be an integer from 1 through 200.");
  }
  const dispositions: Array<"written" | "reused"> = [];
  const ordered = conversations.toSorted(
    (left, right) =>
      right.summary.updatedAt.localeCompare(left.summary.updatedAt) ||
      left.summary.id.localeCompare(right.summary.id),
  );
  if (options.writeIndex !== false) {
    dispositions.push(
      ...(await writePayload(options, ["sessions", "index.json"], {
        version: 1,
        sessions: ordered.map(({ summary }) => summary),
      })),
    );
  }
  let turnChunkCount = 0;
  for (const conversation of options.writeSessions === false ? [] : ordered) {
    const id = conversation.summary.id;
    assertSafeOutputComponent(id);
    // oxlint-disable-next-line no-await-in-loop -- Each session payload set is published coherently before the next one.
    const summaryDispositions = await writePayload(options, ["sessions", id, "summary.json"], {
      summary: conversation.summary,
      diagnostics: options.diagnosticsBySession?.get(id) ?? [],
    });
    dispositions.push(...summaryDispositions);
    // oxlint-disable-next-line no-await-in-loop -- Each session navigator is paired with its chunk size.
    const navigatorDispositions = await writePayload(options, ["sessions", id, "navigator.json"], {
      sessionId: id,
      revision: conversation.summary.revision,
      chunkSize,
      items: conversation.turns.map(navigatorItem),
    });
    dispositions.push(...navigatorDispositions);
    const turnChunks = chunks(conversation.turns, chunkSize);
    const rawEvents = new Map(conversation.rawEvents.map((event) => [event.id, event]));
    for (const [index, turns] of turnChunks.entries()) {
      const turnPayload: TurnChunk = {
        sessionId: id,
        turns,
        previousCursor: index === 0 ? null : String(index - 1),
        nextCursor: index === turnChunks.length - 1 ? null : String(index + 1),
        revision: conversation.summary.revision,
      };
      // oxlint-disable-next-line no-await-in-loop -- Chunks are bounded and written in route order.
      const turnDispositions = await writePayload(
        options,
        ["sessions", id, `turn-${index}.json`],
        turnPayload,
      );
      dispositions.push(...turnDispositions);
      // oxlint-disable-next-line no-await-in-loop -- Inspector chunks align exactly with turn chunks.
      const inspectorDispositions = await writePayload(
        options,
        ["sessions", id, `inspector-${index}.json`],
        {
          sessionId: id,
          revision: conversation.summary.revision,
          records: turns.flatMap((turn) => inspectorsForTurn(turn, rawEvents)),
        },
      );
      dispositions.push(...inspectorDispositions);
      turnChunkCount += 1;
    }
    // oxlint-disable-next-line no-await-in-loop -- Stale chunks are removed only after this session's complete generated payload has succeeded.
    await reconcileSessionChunks(options.generatedRoot, id, turnChunks.length);
    if (options.publicRoot !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- The public mirror is reconciled independently after all of its replacement writes succeed.
      await reconcileSessionChunks(options.publicRoot, id, turnChunks.length);
    }
  }
  return {
    sessionCount: ordered.length,
    turnChunkCount,
    writtenFileCount: dispositions.filter((value) => value === "written").length,
    reusedFileCount: dispositions.filter((value) => value === "reused").length,
    published: options.publicRoot !== undefined,
  };
}

async function mirrorGeneratedTree(
  sourceRoot: string,
  publicRoot: string,
  targetSegments: readonly string[],
): Promise<number> {
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let count = 0;
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    assertSafeOutputComponent(entry.name);
    const sourcePath = join(sourceRoot, entry.name);
    // oxlint-disable-next-line no-await-in-loop -- Every path is verified immediately before its bytes are mirrored.
    const metadata = await lstat(sourcePath);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      // oxlint-disable-next-line no-await-in-loop -- Viewer-owned generated trees are mirrored in deterministic path order.
      count += await mirrorGeneratedTree(sourcePath, publicRoot, [...targetSegments, entry.name]);
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
      throw new Error(`Generated export content is not an unlinked regular file: ${sourcePath}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- Each verified generated file is atomically written to isolated public staging.
    await writeOutputFile(publicRoot, [...targetSegments, entry.name], await readFile(sourcePath));
    count += 1;
  }
  return count;
}

export async function publishGeneratedExportFiles(
  generatedRoot: string,
  publicRoot: string,
): Promise<number> {
  const counts = await Promise.all([
    mirrorGeneratedTree(join(generatedRoot, "payloads"), publicRoot, ["payloads"]),
    mirrorGeneratedTree(join(generatedRoot, "markdown"), publicRoot, ["downloads"]),
  ]);
  return counts.reduce((total, count) => total + count, 0);
}

function rowText(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function rowNumber(row: Record<string, SQLOutputValue>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

async function verifiedCachedBytes(
  path: string,
  expectedHash: string,
): Promise<{ bytes: Buffer; name: string }> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
    throw new Error(`Cached content is not an unlinked regular file: ${path}`);
  }
  const name = basename(path);
  if (!name.startsWith(`${expectedHash}.`) || !/^[a-f\d]{64}\.[a-z\d]{1,12}$/iu.test(name)) {
    throw new Error(`Cached content has a non-content-addressed filename: ${path}`);
  }
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
    throw new Error(`Cached content failed its SHA-256 integrity check: ${path}`);
  }
  return { bytes, name };
}

async function publishContentFile(
  options: Pick<PublishCachedContentOptions, "generatedRoot" | "publicRoot">,
  directory: "assets" | "favicons",
  path: string,
  hash: string,
): Promise<string> {
  const cached = await verifiedCachedBytes(path, hash);
  await writeOutputFile(options.generatedRoot, [directory, cached.name], cached.bytes);
  if (options.publicRoot !== undefined) {
    await writeOutputFile(options.publicRoot, [directory, cached.name], cached.bytes);
  }
  return `/${directory}/${cached.name}`;
}

export async function publishCachedContent(
  database: DatabaseSync,
  options: PublishCachedContentOptions,
): Promise<PublishCachedContentResult> {
  const assets: Array<Record<string, unknown>> = [];
  const favicons: Array<Record<string, unknown>> = [];
  let failedCount = 0;
  const assetQuery = database.prepare(`
    SELECT id, mime_type, byte_size, sha256, width, height, status, original_path, cache_path
    FROM assets
    WHERE id = ?
  `);
  for (const id of [...options.assetIds].toSorted()) {
    assertSafeOutputComponent(id);
    const row = assetQuery.get(id);
    if (row === undefined) {
      assets.push({
        id,
        url: null,
        mimeType: null,
        byteSize: null,
        sha256: null,
        width: null,
        height: null,
        status: "missing",
        originalPath: null,
      });
      continue;
    }
    const hash = rowText(row, "sha256");
    const cachePath = rowText(row, "cache_path");
    let url: string | null = null;
    let status = rowText(row, "status") ?? "error";
    if (status === "available" && hash !== null && cachePath !== null) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Each referenced cache entry is integrity-checked before publication.
        url = await publishContentFile(options, "assets", cachePath, hash);
      } catch {
        status = "error";
        failedCount += 1;
      }
    }
    assets.push({
      id,
      url,
      mimeType: rowText(row, "mime_type"),
      byteSize: rowNumber(row, "byte_size"),
      sha256: hash,
      width: rowNumber(row, "width"),
      height: rowNumber(row, "height"),
      status,
      originalPath: rowText(row, "original_path"),
    });
  }
  const faviconQuery = database.prepare(`
    SELECT origin, url, mime_type, byte_size, sha256, cache_path, status
    FROM favicons
    WHERE origin = ?
  `);
  for (const origin of [...options.faviconOrigins].toSorted()) {
    const row = faviconQuery.get(origin);
    if (row === undefined) {
      continue;
    }
    const hash = rowText(row, "sha256");
    const cachePath = rowText(row, "cache_path");
    if (rowText(row, "status") !== "available" || hash === null || cachePath === null) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each referenced favicon is integrity-checked before publication.
      const url = await publishContentFile(options, "favicons", cachePath, hash);
      favicons.push({
        origin,
        url,
        sourceUrl: rowText(row, "url"),
        mimeType: rowText(row, "mime_type"),
        byteSize: rowNumber(row, "byte_size"),
        sha256: hash,
      });
    } catch {
      failedCount += 1;
    }
  }
  await writePayload(options, ["assets.json"], { version: 1, assets });
  await writePayload(options, ["favicons.json"], { version: 1, favicons });
  return {
    assetCount: assets.filter(({ status }) => status === "available").length,
    faviconCount: favicons.length,
    failedCount,
  };
}

async function safeRemoveGenerated(path: string, expected: "directory" | "file"): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    const safe =
      expected === "directory"
        ? metadata.isDirectory() && !metadata.isSymbolicLink()
        : metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1;
    if (!safe) {
      throw new Error(`Refusing to remove an unsafe generated ${expected}: ${path}`);
    }
    await rm(path, { recursive: expected === "directory" });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function reconcileStaticSessionArtifacts(
  generatedRoot: string,
  expectedScopes: ReadonlyMap<string, ConversationScope>,
  options: ReconcileStaticArtifactsOptions,
): Promise<string[]> {
  if (!options.completeReconciliation) {
    return [];
  }
  const removed: string[] = [];
  for (const scope of ["active", "archived"] as const) {
    const directory = join(generatedRoot, "markdown", scope);
    let entries: string[];
    try {
      // oxlint-disable-next-line no-await-in-loop -- Scope directories are small viewer-owned manifests.
      entries = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries.toSorted()) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const id = entry.slice(0, -3);
      if (expectedScopes.get(id) === scope) {
        continue;
      }
      const path = join(directory, entry);
      // oxlint-disable-next-line no-await-in-loop -- Deletion is allowed only after a complete source reconciliation.
      if (await safeRemoveGenerated(path, "file")) {
        removed.push(path);
      }
    }
  }
  const sessionRoot = join(generatedRoot, "payloads", "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessionRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return removed.toSorted();
    }
    throw error;
  }
  for (const entry of entries.toSorted()) {
    if (entry === "index.json" || expectedScopes.has(entry)) {
      continue;
    }
    const path = join(sessionRoot, entry);
    // oxlint-disable-next-line no-await-in-loop -- Deletion is allowed only after a complete source reconciliation.
    if (await safeRemoveGenerated(path, "directory")) {
      removed.push(path);
    }
  }
  return removed.toSorted();
}
