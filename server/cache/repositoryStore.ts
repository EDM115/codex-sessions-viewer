import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  conversationSummarySchema,
  type ConversationActivity,
  type ConversationMessage,
  type ConversationTurn,
  type JsonValue,
  type TurnNavigatorItem,
} from "../../shared/types/conversation.ts";
import {
  inspectorRecordSchema,
  inspectorTargetSchema,
  sessionListQuerySchema,
  sessionListResponseSchema,
  turnChunkQuerySchema,
  turnChunkSchema,
  turnNavigatorResponseSchema,
  type CursorPage,
  type InspectorRecord,
  type InspectorTarget,
  type SessionListQuery,
  type TurnChunk,
  type TurnChunkQuery,
} from "../../shared/types/repository.ts";
import type { NormalizedRawEvent, NormalizedSession } from "../normalization/normalizeSession.ts";
import { getCachedSession } from "./conversationStore.ts";

const DEFAULT_PAGE_SIZE = 20;

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new Error("The viewer cache contains non-text JSON.");
  }
  return JSON.parse(value) as unknown;
}

function cursorIndex(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d+$/u.test(cursor)) {
    throw new Error("Invalid repository cursor.");
  }
  const value = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error("Invalid repository cursor.");
  }
  return value;
}

function likeValue(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function sessionFilters(query: SessionListQuery): { sql: string; values: SQLInputValue[] } {
  const clauses = ["scope = ?"];
  const values: SQLInputValue[] = [query.scope];
  if (query.query !== undefined && query.query.trim() !== "") {
    clauses.push("(title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')");
    const value = likeValue(query.query.trim());
    values.push(value, value);
  }
  if (query.model !== undefined) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(models_json) WHERE value = ?)");
    values.push(query.model);
  }
  if (query.cwd !== undefined) {
    clauses.push("cwd = ?");
    values.push(query.cwd);
  }
  if (query.tool !== undefined) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(tool_counts_json) WHERE key = ? AND value > 0)");
    values.push(query.tool);
  }
  if (query.hasMedia !== undefined) {
    clauses.push("has_media = ?");
    values.push(query.hasMedia ? 1 : 0);
  }
  return { sql: clauses.join(" AND "), values };
}

export function listCachedSessions(
  database: DatabaseSync,
  input: SessionListQuery,
): CursorPage<ReturnType<typeof conversationSummarySchema.parse>> {
  const query = sessionListQuerySchema.parse(input);
  const limit = query.limit ?? 50;
  const offset = cursorIndex(query.cursor);
  const filters = sessionFilters(query);
  const total = Number(
    database
      .prepare(`SELECT count(*) AS total FROM sessions WHERE ${filters.sql}`)
      .get(...filters.values)?.["total"] ?? 0,
  );
  const items = database
    .prepare(`
      SELECT summary_json
      FROM sessions
      WHERE ${filters.sql}
      ORDER BY updated_at DESC, id
      LIMIT ? OFFSET ?
    `)
    .all(...filters.values, limit, offset)
    .map((row) => conversationSummarySchema.parse(parsedJson(row["summary_json"])));
  return sessionListResponseSchema.parse({
    items,
    nextCursor: offset + items.length < total ? String(offset + items.length) : null,
    total,
  });
}

export function getCachedSessionSummary(
  database: DatabaseSync,
  sessionId: string,
): NormalizedSession["summary"] | null {
  const row = database.prepare("SELECT summary_json FROM sessions WHERE id = ?").get(sessionId);
  return row === undefined
    ? null
    : conversationSummarySchema.parse(parsedJson(row["summary_json"]));
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

export function createTurnNavigatorItem(turn: ConversationTurn): TurnNavigatorItem {
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

export function getCachedTurnNavigator(
  database: DatabaseSync,
  sessionId: string,
): TurnNavigatorItem[] | null {
  const session = getCachedSession(database, sessionId);
  return session === null
    ? null
    : turnNavigatorResponseSchema.parse(session.turns.map(createTurnNavigatorItem));
}

export function getCachedTurnChunk(
  database: DatabaseSync,
  sessionId: string,
  input: TurnChunkQuery,
): TurnChunk | null {
  const query = turnChunkQuerySchema.parse(input);
  const session = getCachedSession(database, sessionId);
  if (session === null) {
    return null;
  }
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const chunkCount = Math.ceil(session.turns.length / limit);
  let chunk = cursorIndex(query.cursor);
  if (query.targetTurnId !== undefined) {
    const target = session.turns.findIndex(({ id }) => id === query.targetTurnId);
    if (target < 0) {
      return null;
    }
    chunk = Math.floor(target / limit);
  }
  if (chunk < 0 || (chunkCount > 0 && chunk >= chunkCount)) {
    return null;
  }
  const start = chunk * limit;
  return turnChunkSchema.parse({
    sessionId,
    turns: session.turns.slice(start, start + limit),
    previousCursor: chunk > 0 ? String(chunk - 1) : null,
    nextCursor: chunk + 1 < chunkCount ? String(chunk + 1) : null,
    revision: session.summary.revision,
  });
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
  return inspectorRecordSchema.parse({
    sessionId: turn.sessionId,
    target,
    models: turn.models,
    reasoningEfforts: turn.reasoningEfforts,
    phase: input.phase,
    createdAt: input.createdAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    timeToFirstTokenMs: target.type === "turn" ? turn.timeToFirstTokenMs : null,
    tokenDelta: target.type === "turn" ? turn.tokenDelta : null,
    toolCounts: turn.toolCounts,
    activityIds: input.activityIds,
    eventIds: input.eventIds,
    diagnosticIds: turn.diagnosticIds,
    rawRecords: input.eventIds
      .map((id) => rawEvents.get(id))
      .filter((event): event is NormalizedRawEvent => event !== undefined)
      .map(rawRecord),
  });
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
      completedAt: null,
      durationMs: null,
      eventIds: message.rawEventIds,
      activityIds: turn.activities.map(({ id }) => id),
    },
    rawEvents,
  );
}

function activityInspector(
  turn: ConversationTurn,
  activity: ConversationActivity,
  rawEvents: ReadonlyMap<string, NormalizedRawEvent>,
): InspectorRecord {
  return targetRecord(
    turn,
    { type: "activity", id: activity.id },
    {
      phase: null,
      createdAt: activity.createdAt,
      completedAt: activity.kind === "tool" ? activity.completedAt : null,
      durationMs: activity.kind === "tool" ? activity.durationMs : null,
      eventIds: activity.rawEventIds,
      activityIds: [activity.id],
    },
    rawEvents,
  );
}

export function getCachedInspector(
  database: DatabaseSync,
  sessionId: string,
  input: InspectorTarget,
): InspectorRecord | null {
  const target = inspectorTargetSchema.parse(input);
  const session = getCachedSession(database, sessionId);
  if (session === null) {
    return null;
  }
  const rawEvents = new Map(session.rawEvents.map((event) => [event.id, event]));
  for (const turn of session.turns) {
    if (target.type === "turn" && turn.id === target.id) {
      const eventIds = [
        ...new Set([
          ...(turn.userMessage?.rawEventIds ?? []),
          ...turn.assistantMessages.flatMap(({ rawEventIds }) => rawEventIds),
          ...turn.activities.flatMap(({ rawEventIds }) => rawEventIds),
        ]),
      ];
      return targetRecord(
        turn,
        target,
        {
          phase: null,
          createdAt: turn.startedAt,
          completedAt: turn.completedAt,
          durationMs: turn.durationMs,
          eventIds,
          activityIds: turn.activities.map(({ id }) => id),
        },
        rawEvents,
      );
    }
    if (target.type === "message") {
      const message = [turn.userMessage, ...turn.assistantMessages].find(
        (candidate) => candidate?.id === target.id,
      );
      if (message !== undefined && message !== null) {
        return messageInspector(turn, message, rawEvents);
      }
    }
    if (target.type === "activity") {
      const activity = turn.activities.find(({ id }) => id === target.id);
      if (activity !== undefined) {
        return activityInspector(turn, activity, rawEvents);
      }
    }
  }
  return null;
}
