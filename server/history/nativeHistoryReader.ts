import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import * as z from "zod";

import { adaptNativeThreadItem } from "#server/history/nativeItemAdapter.ts";
import type { ResolvedRolloutLineage } from "#server/ingestion/rolloutLineage.ts";
import {
  historySnapshotUnchanged,
  type HistorySnapshot,
} from "#server/metadata/historySnapshot.ts";
import {
  historyPageSchema,
  type HistoryCoverage,
  type HistoryPage,
  type HistoryTurnWindow,
} from "#shared/types/history.ts";
import {
  historyItemQuerySchema,
  historyPageQuerySchema,
  type HistoryItemQuery,
  type HistoryPageQuery,
} from "#shared/types/repository.ts";

export const NATIVE_HISTORY_LIMITS = {
  initialTurns: 5,
  olderTurns: 20,
  items: 100,
  openingItems: 2,
  openingBatches: 32,
  payloadBytes: 2 * 1024 * 1024,
  itemBytes: 256 * 1024,
  segments: 32,
} as const;
export interface NativeQueryTrace {
  sql: string;
  rows: number;
  payloadBytes: number;
}
export interface NativeHistoryPageResult {
  status: "available" | "unavailable";
  page: HistoryPage | null;
  snapshot: HistorySnapshot;
  query: HistoryPageQuery | HistoryItemQuery;
  requestDependency: string | null;
  diagnostics: string[];
  stats: { statements: NativeQueryTrace[]; payloadBytes: number; maxConcurrentReads: number };
}
const number = z.int().nonnegative();
const turnRowSchema = z.object({
  thread_id: z.string(),
  turn_id: z.string(),
  rollout_ordinal: number,
  status: z.string(),
  started_at: z.number().nullable(),
  completed_at: z.number().nullable(),
  duration_ms: number.nullable(),
  first_user_item_id: z.string().nullable(),
  final_agent_item_id: z.string().nullable(),
  rollout_end_ordinal: number.nullable(),
});
type TurnRow = z.infer<typeof turnRowSchema> & { segment: number };
const itemRowSchema = z.object({
  item_id: z.string(),
  rollout_ordinal: number,
  updated_at_ordinal: number.nullable(),
  payload_bytes: number,
  started_at_ms: number.nullable(),
  completed_at_ms: number.nullable(),
});
type ItemRow = z.infer<typeof itemRowSchema>;
export const nativeCursorBoundarySchema = z.strictObject({
  scope: z.enum(["turns", "items"]),
  threadId: z.string(),
  turnId: z.string().nullable(),
  lineage: z.string(),
  segment: number,
  ordinal: number,
  id: z.string(),
});
const cursorSchema = nativeCursorBoundarySchema.extend({
  version: z.literal(2),
  epoch: z.string(),
  dependency: z.string().nullable(),
});
type NativeCursor = z.infer<typeof cursorSchema>;
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function nativeLineageIdentity(lineage: ResolvedRolloutLineage): string {
  return digest([
    lineage.historyEpoch,
    lineage.status,
    lineage.segments.map((segment) => [
      segment.ref,
      segment.bodyStartOrdinal,
      segment.displayStartOrdinal,
      segment.endOrdinalExclusive,
      segment.endByteOffset,
    ]),
  ]);
}
function encodeCursor(value: NativeCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeNativeHistoryCursor(value: string): NativeCursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new Error("Invalid native history cursor, reload the selected history");
  }
}
export function nativeCursorBoundary(
  cursor: NativeCursor,
): z.infer<typeof nativeCursorBoundarySchema> {
  const { version: _version, epoch: _epoch, dependency: _dependency, ...boundary } = cursor;
  return boundary;
}
export function pageCursorBoundaries(
  page: HistoryPage,
): z.infer<typeof nativeCursorBoundarySchema>[] {
  return [
    page.beforeCursor,
    page.afterCursor,
    ...page.turns.flatMap((turn) => [turn.beforeCursor, turn.afterCursor]),
  ].flatMap((cursor) =>
    cursor === null ? [] : [nativeCursorBoundary(decodeNativeHistoryCursor(cursor))],
  );
}
export function qualifyPageCursors(
  page: HistoryPage,
  dependency: string,
  historyEpoch: string,
): HistoryPage {
  const cursor = (value: string | null) =>
    value === null
      ? null
      : encodeCursor({ ...decodeNativeHistoryCursor(value), dependency, epoch: historyEpoch });
  return {
    ...page,
    historyEpoch,
    beforeCursor: cursor(page.beforeCursor),
    afterCursor: cursor(page.afterCursor),
    turns: page.turns.map((turn) => ({
      ...turn,
      historyEpoch,
      beforeCursor: cursor(turn.beforeCursor),
      afterCursor: cursor(turn.afterCursor),
    })),
  };
}

class NativePageReader {
  readonly database: DatabaseSync;
  readonly lineage: ResolvedRolloutLineage;
  readonly snapshot: HistorySnapshot;
  readonly result: NativeHistoryPageResult;
  readonly epoch: string;
  readonly threadId: string;
  readonly signal: AbortSignal | undefined;
  constructor(
    database: DatabaseSync,
    lineage: ResolvedRolloutLineage,
    snapshot: HistorySnapshot,
    result: NativeHistoryPageResult,
    signal?: AbortSignal,
  ) {
    this.database = database;
    this.lineage = lineage;
    this.snapshot = snapshot;
    this.result = result;
    this.signal = signal;
    this.epoch = digest([nativeLineageIdentity(lineage), snapshot.digest, "native-page-v1"]);
    this.threadId = lineage.segments.at(-1)!.ref.stableThreadId;
  }
  rows(sql: string, parameters: SQLInputValue[]) {
    this.signal?.throwIfAborted();
    const rows = this.database.prepare(sql).all(...parameters);
    const payloadBytes = rows.reduce(
      (total, row) =>
        total + (typeof row["item_json"] === "string" ? Buffer.byteLength(row["item_json"]) : 0),
      0,
    );
    this.result.stats.payloadBytes += payloadBytes;
    this.result.stats.statements.push({ sql, rows: rows.length, payloadBytes });
    return rows;
  }
  cursor(
    scope: "turns" | "items",
    row: { segment: number; rollout_ordinal: number },
    id: string,
    turnId: string | null,
  ): string {
    return encodeCursor({
      version: 2,
      scope,
      threadId: this.threadId,
      turnId,
      lineage: nativeLineageIdentity(this.lineage),
      epoch: this.epoch,
      segment: row.segment,
      ordinal: row.rollout_ordinal,
      id,
      dependency: null,
    });
  }
  parseCursor(query: HistoryPageQuery | HistoryItemQuery): NativeCursor | null {
    if (!("cursor" in query.anchor)) {
      return null;
    }
    const cursor = decodeNativeHistoryCursor(query.anchor.cursor);
    const turnId = "turnId" in query ? query.turnId : null;
    if (
      cursor.threadId !== this.threadId ||
      cursor.lineage !== nativeLineageIdentity(this.lineage) ||
      (cursor.dependency === null && cursor.epoch !== this.epoch) ||
      cursor.turnId !== turnId ||
      cursor.scope !== (turnId === null ? "turns" : "items") ||
      cursor.segment >= this.lineage.segments.length
    ) {
      throw new Error("Stale or wrong-owner native history cursor, reload the selected history");
    }
    this.result.requestDependency = cursor.dependency;
    return cursor;
  }
  segmentPredicate(
    segmentIndex: number,
    alias: string,
    suppress = true,
  ): { sql: string; params: SQLInputValue[] } {
    const segment = this.lineage.segments[segmentIndex]!;
    const params: SQLInputValue[] = [
      segment.ref.physicalRolloutId!,
      segment.displayStartOrdinal,
      segment.endOrdinalExclusive ?? Number.MAX_SAFE_INTEGER,
    ];
    let sql = `${alias}.thread_id = ? AND ${alias}.rollout_ordinal >= ? AND ${alias}.rollout_ordinal < ?`;
    if (suppress) {
      for (const newer of this.lineage.segments.slice(segmentIndex + 1)) {
        sql += ` AND NOT EXISTS (SELECT 1 FROM thread_turns newer WHERE newer.thread_id = ? AND newer.turn_id = ${alias}.turn_id AND newer.rollout_ordinal >= ? AND newer.rollout_ordinal < ?)`;
        params.push(
          newer.ref.physicalRolloutId,
          newer.bodyStartOrdinal,
          newer.endOrdinalExclusive ?? Number.MAX_SAFE_INTEGER,
        );
      }
    }
    return { sql, params };
  }
  turnRows(
    query: HistoryPageQuery | HistoryItemQuery,
    cursor: NativeCursor | null,
  ): { rows: TurnRow[]; more: boolean } {
    const target =
      "turnId" in query ? query.turnId : query.anchor.kind === "turn" ? query.anchor.turnId : null;
    const limit =
      target === null
        ? (query.limit ??
          (query.anchor.kind === "latest"
            ? NATIVE_HISTORY_LIMITS.initialTurns
            : NATIVE_HISTORY_LIMITS.olderTurns))
        : 1;
    const ascending = query.anchor.kind === "after";
    const indices = this.lineage.segments.map((_segment, index) => index);
    if (!ascending) {
      indices.reverse();
    }
    const rows: TurnRow[] = [];
    for (const index of indices) {
      if (rows.length >= limit + 1) {
        break;
      }
      if (
        cursor &&
        target === null &&
        (ascending ? index < cursor.segment : index > cursor.segment)
      ) {
        continue;
      }
      const predicate = this.segmentPredicate(index, "t");
      let filter = predicate.sql;
      if (target !== null) {
        filter += " AND t.turn_id = ?";
        predicate.params.push(target);
      }
      if (cursor && target === null && index === cursor.segment) {
        filter += ` AND (t.rollout_ordinal,t.turn_id) ${ascending ? ">" : "<"} (?,?)`;
        predicate.params.push(cursor.ordinal, cursor.id);
      }
      const end = this.snapshot.capabilities.turnEndOrdinal
        ? "t.rollout_end_ordinal"
        : "NULL AS rollout_end_ordinal";
      const sql = `SELECT t.thread_id,t.turn_id,t.rollout_ordinal,t.status,t.started_at,t.completed_at,t.duration_ms,t.first_user_item_id,t.final_agent_item_id,${end} FROM thread_turns t WHERE ${filter} ORDER BY t.rollout_ordinal ${ascending ? "ASC" : "DESC"},t.turn_id ${ascending ? "ASC" : "DESC"} LIMIT ?`;
      rows.push(
        ...this.rows(sql, [...predicate.params, limit + 1 - rows.length]).map((row) =>
          Object.assign(turnRowSchema.parse(row), { segment: index }),
        ),
      );
    }
    const more = rows.length > limit;
    return {
      rows: rows
        .slice(0, limit)
        .toSorted(
          (a, b) =>
            a.segment - b.segment ||
            a.rollout_ordinal - b.rollout_ordinal ||
            a.turn_id.localeCompare(b.turn_id),
        ),
      more,
    };
  }
  coverage(): HistoryCoverage {
    return {
      status: this.lineage.status === "complete" ? "partial" : "unresolved",
      segments: this.lineage.segments.map((segment) => {
        const row = this.rows(
          "SELECT next_rollout_ordinal,next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id = ? LIMIT 1",
          [segment.ref.physicalRolloutId!],
        )[0];
        const watermark = z
          .object({ next_rollout_ordinal: number, next_rollout_byte_offset: number })
          .safeParse(row);
        return {
          physicalRolloutId: segment.ref.physicalRolloutId!,
          endOrdinalExclusive: segment.endOrdinalExclusive,
          endDecodedByteExclusive: segment.endByteOffset,
          coveredRanges: [],
          projectionWatermark: watermark.success
            ? {
                nextOrdinal: watermark.data.next_rollout_ordinal,
                nextByteOffset: watermark.data.next_rollout_byte_offset,
              }
            : null,
          sourceWatermark: null,
        };
      }),
      gaps: [],
    };
  }
  itemRows(
    turn: TurnRow,
    limit: number,
    ascending: boolean,
    cursor: { ordinal: number; id: string } | null,
  ): ItemRow[] {
    const predicate = this.segmentPredicate(turn.segment, "i", false);
    let filter = `${predicate.sql} AND i.turn_id = ?`;
    const params = [...predicate.params, turn.turn_id];
    if (cursor !== null) {
      filter += ` AND (i.rollout_ordinal,i.item_id) ${ascending ? ">" : "<"} (?,?)`;
      params.push(cursor.ordinal, cursor.id);
    }
    const updated = this.snapshot.capabilities.updatedAtOrdinal
      ? "i.updated_at_ordinal"
      : "NULL AS updated_at_ordinal";
    const times = this.snapshot.capabilities.itemLifecycle
      ? "i.started_at_ms,i.completed_at_ms"
      : "NULL AS started_at_ms,NULL AS completed_at_ms";
    return this.rows(
      `SELECT i.item_id,i.rollout_ordinal,${updated},${times},length(CAST(i.item_json AS BLOB)) AS payload_bytes FROM thread_items i WHERE ${filter} ORDER BY i.rollout_ordinal ${ascending ? "ASC" : "DESC"},i.item_id ${ascending ? "ASC" : "DESC"} LIMIT ?`,
      [...params, limit],
    ).map((row) => itemRowSchema.parse(row));
  }
  loadItems(turn: TurnRow, rows: ItemRow[]): HistoryTurnWindow["items"] {
    const segment = this.lineage.segments[turn.segment]!;
    const results: HistoryTurnWindow["items"] = [];
    for (const row of rows) {
      let item: HistoryTurnWindow["items"][number]["item"] = null;
      const cut = segment.endOrdinalExclusive;
      const cutoffUnsafe =
        cut !== null &&
        (row.updated_at_ordinal === null ||
          row.updated_at_ordinal === 0 ||
          row.updated_at_ordinal >= cut);
      if (cutoffUnsafe) {
        this.result.diagnostics.push("native.cutoff_update");
      } else if (
        row.payload_bytes > NATIVE_HISTORY_LIMITS.itemBytes ||
        this.result.stats.payloadBytes + row.payload_bytes > NATIVE_HISTORY_LIMITS.payloadBytes
      ) {
        this.result.diagnostics.push("native.payload_budget");
      } else {
        const payload = this.rows(
          "SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ? AND length(CAST(item_json AS BLOB)) <= ? LIMIT 1",
          [
            segment.ref.physicalRolloutId!,
            turn.turn_id,
            row.item_id,
            Math.min(
              NATIVE_HISTORY_LIMITS.itemBytes,
              NATIVE_HISTORY_LIMITS.payloadBytes - this.result.stats.payloadBytes,
            ),
          ],
        )[0]?.["item_json"];
        if (typeof payload === "string") {
          try {
            item = adaptNativeThreadItem(JSON.parse(payload));
            if (item?.id !== row.item_id) {
              item = null;
            }
            if (item && this.snapshot.capabilities.itemLifecycle) {
              item = {
                ...item,
                startedAtMs: row.started_at_ms ?? item.startedAtMs,
                completedAtMs:
                  (row.completed_at_ms === 0 ? null : row.completed_at_ms) ?? item.completedAtMs,
              };
            }
          } catch {
            item = null;
          }
        }
        if (item === null) {
          this.result.diagnostics.push("native.unsupported_item");
        }
      }
      results.push({
        physicalRolloutId: segment.ref.physicalRolloutId!,
        ordinal: row.rollout_ordinal,
        updatedAtOrdinal: row.updated_at_ordinal,
        itemId: row.item_id,
        detail: item === null ? "unsupported" : "full",
        item,
      });
    }
    return results;
  }
  opening(turn: TurnRow): HistoryTurnWindow["opening"] {
    let cursor: { ordinal: number; id: string } | null = null;
    for (let batch = 0; batch < NATIVE_HISTORY_LIMITS.openingBatches; batch += 1) {
      const rows = this.itemRows(turn, NATIVE_HISTORY_LIMITS.openingItems, true, cursor);
      for (const row of rows) {
        const entry = this.loadItems(turn, [row])[0]!;
        if (entry.item?.type === "userMessage") {
          return { itemId: entry.itemId, availability: "available", item: entry.item };
        }
        if (entry.detail === "unsupported") {
          return { itemId: turn.first_user_item_id, availability: "unsupported", item: null };
        }
        if (entry.item?.type !== "contextCompaction") {
          return { itemId: turn.first_user_item_id, availability: "absent", item: null };
        }
      }
      if (rows.length < NATIVE_HISTORY_LIMITS.openingItems) {
        return { itemId: turn.first_user_item_id, availability: "absent", item: null };
      }
      const last = rows.at(-1)!;
      cursor = { ordinal: last.rollout_ordinal, id: last.item_id };
    }
    return { itemId: turn.first_user_item_id, availability: "notLoaded", item: null };
  }
  window(
    turn: TurnRow,
    coverage: HistoryCoverage,
    query?: HistoryItemQuery,
    cursor: NativeCursor | null = null,
  ): HistoryTurnWindow {
    const segment = this.lineage.segments[turn.segment]!;
    if (cursor && cursor.segment !== turn.segment) {
      throw new Error("Stale item cursor segment");
    }
    const ascending = query?.anchor.kind === "after" || query?.anchor.kind === "opening";
    const limit =
      query?.limit ??
      (query?.anchor.kind === "opening"
        ? NATIVE_HISTORY_LIMITS.openingItems
        : NATIVE_HISTORY_LIMITS.items);
    const selected = this.itemRows(turn, limit + 1, ascending, cursor);
    const more = selected.length > limit;
    const rows = selected
      .slice(0, limit)
      .toSorted(
        (a, b) => a.rollout_ordinal - b.rollout_ordinal || a.item_id.localeCompare(b.item_id),
      );
    const opening = this.opening(turn);
    const items = this.loadItems(turn, ascending ? rows : rows.toReversed());
    if (!ascending) {
      items.reverse();
    }
    const first = rows[0];
    const last = rows.at(-1);
    const boundaryUnsafe =
      segment.endOrdinalExclusive !== null &&
      (turn.rollout_end_ordinal === null ||
        turn.rollout_end_ordinal >= segment.endOrdinalExclusive);
    if (boundaryUnsafe) {
      this.result.diagnostics.push("native.cutoff_update");
    }
    const before =
      first && (!ascending ? more : cursor !== null)
        ? this.cursor("items", { ...first, segment: turn.segment }, first.item_id, turn.turn_id)
        : null;
    const after =
      last && (ascending ? more : cursor !== null)
        ? this.cursor("items", { ...last, segment: turn.segment }, last.item_id, turn.turn_id)
        : null;
    const loadedRanges =
      first && last
        ? [
            {
              physicalRolloutId: segment.ref.physicalRolloutId!,
              startOrdinal: first.rollout_ordinal,
              endOrdinalExclusive: last.rollout_ordinal + 1,
            },
          ]
        : [];
    const gaps: HistoryCoverage["gaps"] = before
      ? [
          {
            physicalRolloutId: segment.ref.physicalRolloutId!,
            turnId: turn.turn_id,
            reason: "Earlier items have not been loaded",
            beforeOrdinal: null,
            afterOrdinal: first!.rollout_ordinal,
          },
        ]
      : [];
    if (after) {
      gaps.push({
        physicalRolloutId: segment.ref.physicalRolloutId!,
        turnId: turn.turn_id,
        reason: "Later items have not been loaded",
        beforeOrdinal: last!.rollout_ordinal,
        afterOrdinal: null,
      });
    }
    if (items.some((item) => item.detail === "unsupported")) {
      gaps.push({
        physicalRolloutId: segment.ref.physicalRolloutId!,
        turnId: turn.turn_id,
        reason: "Native item details are unsupported or exceed the read budget",
        beforeOrdinal: null,
        afterOrdinal: null,
      });
    }
    return {
      turnId: turn.turn_id,
      physicalRolloutId: segment.ref.physicalRolloutId!,
      order: turn.rollout_ordinal,
      status: boundaryUnsafe
        ? "unknown"
        : z
            .enum(["inProgress", "completed", "failed", "interrupted", "unknown"])
            .catch("unknown")
            .parse(turn.status),
      startedAt: turn.started_at,
      completedAt: boundaryUnsafe ? null : turn.completed_at,
      durationMs: boundaryUnsafe ? null : turn.duration_ms,
      finalAnswerItemId: boundaryUnsafe ? null : turn.final_agent_item_id,
      opening,
      items,
      itemsView:
        before === null && after === null && items.every((item) => item.detail === "full")
          ? "full"
          : "summary",
      beforeCursor: before,
      afterCursor: after,
      loadedRanges,
      coverage: { ...coverage, gaps },
      historyEpoch: this.epoch,
      contentRevision: this.snapshot.digest,
    };
  }
  read(query: HistoryPageQuery | HistoryItemQuery): HistoryPage {
    const cursor = this.parseCursor(query);
    const selected = this.turnRows(query, cursor);
    const coverage = this.coverage();
    const turns = selected.rows
      .toReversed()
      .map((turn) =>
        this.window(
          turn,
          coverage,
          "turnId" in query ? query : undefined,
          "turnId" in query ? cursor : null,
        ),
      )
      .toReversed();
    coverage.gaps = turns.flatMap((turn) => turn.coverage.gaps);
    for (const segment of coverage.segments) {
      segment.coveredRanges = turns
        .filter((turn) => turn.physicalRolloutId === segment.physicalRolloutId)
        .flatMap((turn) => turn.loadedRanges);
    }
    const first = selected.rows[0];
    const last = selected.rows.at(-1);
    const ascending = query.anchor.kind === "after";
    return historyPageSchema.parse({
      threadId: this.threadId,
      metadataRevision: null,
      historyEpoch: this.epoch,
      contentRevision: this.snapshot.digest,
      turns,
      beforeCursor:
        first && (query.anchor.kind === "turn" || (ascending ? cursor !== null : selected.more))
          ? this.cursor("turns", first, first.turn_id, null)
          : null,
      afterCursor:
        last && (query.anchor.kind === "turn" || (ascending ? selected.more : cursor !== null))
          ? this.cursor("turns", last, last.turn_id, null)
          : null,
      coverage,
      preparation: "partial",
    });
  }
}

async function readNative(
  lineage: ResolvedRolloutLineage,
  query: HistoryPageQuery | HistoryItemQuery,
  snapshot: HistorySnapshot,
  signal?: AbortSignal,
): Promise<NativeHistoryPageResult> {
  signal?.throwIfAborted();
  const result: NativeHistoryPageResult = {
    status: "unavailable",
    page: null,
    snapshot,
    query,
    requestDependency: null,
    diagnostics: [],
    stats: { statements: [], payloadBytes: 0, maxConcurrentReads: 1 },
  };
  if (
    lineage.segments.length === 0 ||
    lineage.segments.length > NATIVE_HISTORY_LIMITS.segments ||
    lineage.segments.some((segment) => segment.ref.physicalRolloutId === null) ||
    !(await historySnapshotUnchanged(snapshot))
  ) {
    result.diagnostics.push("native.snapshot_unavailable");
    return result;
  }
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(snapshot.databasePath, {
      readOnly: true,
      allowExtension: false,
      timeout: 100,
    });
    database.enableDefensive(true);
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    const reader = new NativePageReader(database, lineage, snapshot, result, signal);
    result.page = reader.read(query);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && /cursor/iu.test(error.message))) {
      throw error;
    }
    result.page = null;
    result.diagnostics.push("native.query_unavailable");
  } finally {
    database?.close();
  }
  signal?.throwIfAborted();
  if (!(await historySnapshotUnchanged(snapshot))) {
    result.page = null;
    result.diagnostics.push("native.snapshot_changed");
  }
  result.status = result.page === null ? "unavailable" : "available";
  result.diagnostics = [...new Set(result.diagnostics)];
  return result;
}
export function readNativeHistoryPage(
  lineage: ResolvedRolloutLineage,
  query: HistoryPageQuery,
  snapshot: HistorySnapshot,
  signal?: AbortSignal,
): Promise<NativeHistoryPageResult> {
  return readNative(lineage, historyPageQuerySchema.parse(query), snapshot, signal);
}
export function readNativeTurnItems(
  lineage: ResolvedRolloutLineage,
  query: HistoryItemQuery,
  snapshot: HistorySnapshot,
  signal?: AbortSignal,
): Promise<NativeHistoryPageResult> {
  return readNative(lineage, historyItemQuerySchema.parse(query), snapshot, signal);
}
