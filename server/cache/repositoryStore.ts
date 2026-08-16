import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import {
  conversationSummarySchema,
  conversationTurnSchema,
  jsonValueSchema,
  type ConversationActivity,
  type ConversationMessage,
  type ConversationTurn,
  type JsonValue,
  type TurnNavigatorItem,
} from "../../shared/types/conversation.ts";
import type { ConversationListItem } from "../../shared/types/library.ts";
import {
  inspectorRecordSchema,
  inspectorTargetSchema,
  sessionListQuerySchema,
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
import { listCatalogSessions } from "./catalogStore.ts";

const DEFAULT_PAGE_SIZE = 20;
const RAW_EVENT_QUERY_SIZE = 400;

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new Error("The viewer cache contains non-text JSON.");
  }
  return JSON.parse(value) as unknown;
}

function requiredText(value: SQLOutputValue | undefined, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`The viewer cache column ${column} is not text.`);
  }
  return value;
}

function nullableText(value: SQLOutputValue | undefined, column: string): string | null {
  if (value === null) {
    return null;
  }
  return requiredText(value, column);
}

function requiredInteger(value: SQLOutputValue | undefined, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The viewer cache column ${column} is not a non-negative integer.`);
  }
  return value;
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

export function listCachedSessions(
  database: DatabaseSync,
  input: SessionListQuery,
): CursorPage<ConversationListItem> {
  const query = sessionListQuerySchema.parse(input);
  cursorIndex(query.cursor);
  return listCatalogSessions(database, query);
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

function proseLengthBucketFromLength(length: number): 1 | 2 | 3 | 4 {
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

function proseLengthBucket(turn: ConversationTurn): 1 | 2 | 3 | 4 {
  return proseLengthBucketFromLength(
    (turn.userMessage?.sourceMarkdown.length ?? 0) +
      (turn.steeringMessages ?? []).reduce(
        (total, message) => total + message.sourceMarkdown.length,
        0,
      ) +
      turn.assistantMessages.reduce((total, message) => total + message.sourceMarkdown.length, 0),
  );
}

export function createTurnNavigatorItem(turn: ConversationTurn): TurnNavigatorItem {
  return {
    turnId: turn.id,
    index: turn.index,
    userMessageId: turn.userMessage?.id ?? null,
    promptPreview: preview(turn.userMessage?.sourceMarkdown ?? "", 160),
    assistantPreview: preview(
      turn.assistantMessages.find(({ id }) => id === turn.finalAssistantMessageId)
        ?.sourceMarkdown ??
        turn.assistantMessages.at(-1)?.sourceMarkdown ??
        "",
      320,
    ),
    proseLengthBucket: proseLengthBucket(turn),
    createdAt: turn.userMessage?.createdAt ?? turn.startedAt,
  };
}

export function getCachedTurnNavigator(
  database: DatabaseSync,
  sessionId: string,
): TurnNavigatorItem[] | null {
  if (database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) === undefined) {
    return null;
  }
  const rows = database
    .prepare(`
      SELECT
        turns.id AS turn_id,
        turns.turn_index,
        turns.started_at,
        messages.id AS message_id,
        messages.role,
        messages.created_at,
        messages.source_markdown
      FROM turns
      LEFT JOIN messages
        ON messages.session_id = turns.session_id
        AND messages.turn_id = turns.id
      WHERE turns.session_id = ?
      ORDER BY turns.turn_index, messages.rowid
    `)
    .all(sessionId);
  const drafts = new Map<
    string,
    {
      turnId: string;
      index: number;
      startedAt: string | null;
      userMessageId: string | null;
      userCreatedAt: string | null;
      prompt: string;
      assistant: string;
      proseLength: number;
    }
  >();
  for (const row of rows) {
    const turnId = requiredText(row["turn_id"], "turn_id");
    let draft = drafts.get(turnId);
    if (draft === undefined) {
      draft = {
        turnId,
        index: requiredInteger(row["turn_index"], "turn_index"),
        startedAt: nullableText(row["started_at"], "started_at"),
        userMessageId: null,
        userCreatedAt: null,
        prompt: "",
        assistant: "",
        proseLength: 0,
      };
      drafts.set(turnId, draft);
    }
    if (row["message_id"] === null) {
      continue;
    }
    const role = requiredText(row["role"], "role");
    const markdown = requiredText(row["source_markdown"], "source_markdown");
    draft.proseLength += markdown.length;
    if (role === "user") {
      draft.userMessageId ??= requiredText(row["message_id"], "message_id");
      draft.userCreatedAt ??= requiredText(row["created_at"], "created_at");
      draft.prompt ||= markdown;
    } else if (draft.assistant === "") {
      draft.assistant = markdown;
    }
  }
  return turnNavigatorResponseSchema.parse(
    [...drafts.values()].map((draft) => ({
      turnId: draft.turnId,
      index: draft.index,
      userMessageId: draft.userMessageId,
      promptPreview: preview(draft.prompt, 160),
      assistantPreview: preview(draft.assistant, 320),
      proseLengthBucket: proseLengthBucketFromLength(draft.proseLength),
      createdAt: draft.userCreatedAt ?? draft.startedAt,
    })),
  );
}

export function getCachedTurnChunk(
  database: DatabaseSync,
  sessionId: string,
  input: TurnChunkQuery,
): TurnChunk | null {
  const query = turnChunkQuerySchema.parse(input);
  const session = database
    .prepare("SELECT turn_count, revision FROM sessions WHERE id = ?")
    .get(sessionId);
  if (session === undefined) {
    return null;
  }
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const turnCount = requiredInteger(session["turn_count"], "turn_count");
  const chunkCount = Math.ceil(turnCount / limit);
  let chunk = cursorIndex(query.cursor);
  if (query.targetTurnId !== undefined) {
    const target = database
      .prepare("SELECT turn_index FROM turns WHERE session_id = ? AND id = ?")
      .get(sessionId, query.targetTurnId);
    if (target === undefined) {
      return null;
    }
    chunk = Math.floor(requiredInteger(target["turn_index"], "turn_index") / limit);
  }
  if (chunk < 0 || (chunkCount > 0 && chunk >= chunkCount)) {
    return null;
  }
  const start = chunk * limit;
  return turnChunkSchema.parse({
    sessionId,
    turns: database
      .prepare(`
        SELECT payload_json
        FROM turns
        WHERE session_id = ?
        ORDER BY turn_index
        LIMIT ? OFFSET ?
      `)
      .all(sessionId, limit, start)
      .map((row) => conversationTurnSchema.parse(parsedJson(row["payload_json"]))),
    previousCursor: chunk > 0 ? String(chunk - 1) : null,
    nextCursor: chunk + 1 < chunkCount ? String(chunk + 1) : null,
    revision: requiredText(session["revision"], "revision"),
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
    timeToFirstTokenMs: target.type === "activity" ? null : turn.timeToFirstTokenMs,
    tokenDelta: target.type === "activity" ? null : turn.tokenDelta,
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

function turnEventIds(turn: ConversationTurn): string[] {
  return [
    ...new Set([
      ...(turn.userMessage?.rawEventIds ?? []),
      ...(turn.steeringMessages ?? []).flatMap(({ rawEventIds }) => rawEventIds),
      ...turn.assistantMessages.flatMap(({ rawEventIds }) => rawEventIds),
      ...turn.activities.flatMap(({ rawEventIds }) => rawEventIds),
    ]),
  ];
}

function rawEventsById(
  database: DatabaseSync,
  sessionId: string,
  eventIds: readonly string[],
): ReadonlyMap<string, NormalizedRawEvent> {
  const uniqueIds = [...new Set(eventIds)];
  const events = new Map<string, NormalizedRawEvent>();
  for (let offset = 0; offset < uniqueIds.length; offset += RAW_EVENT_QUERY_SIZE) {
    const ids = uniqueIds.slice(offset, offset + RAW_EVENT_QUERY_SIZE);
    const placeholders = ids.map(() => "?").join(", ");
    for (const row of database
      .prepare(`
        SELECT id, turn_id, type, timestamp, payload_json
        FROM raw_events
        WHERE session_id = ? AND id IN (${placeholders})
      `)
      .all(sessionId, ...ids)) {
      const id = requiredText(row["id"], "id");
      events.set(id, {
        id,
        turnId: nullableText(row["turn_id"], "turn_id"),
        type: requiredText(row["type"], "type"),
        timestamp: nullableText(row["timestamp"], "timestamp"),
        payload: jsonValueSchema.parse(parsedJson(row["payload_json"])),
      });
    }
  }
  return events;
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
  const targetRow =
    target.type === "turn"
      ? database
          .prepare("SELECT id AS turn_id FROM turns WHERE session_id = ? AND id = ?")
          .get(sessionId, target.id)
      : database
          .prepare(
            `SELECT turn_id FROM ${target.type === "message" ? "messages" : "activities"} WHERE session_id = ? AND id = ?`,
          )
          .get(sessionId, target.id);
  if (targetRow === undefined) {
    return null;
  }
  const turnId = requiredText(targetRow["turn_id"], "turn_id");
  const turnRow = database
    .prepare("SELECT payload_json FROM turns WHERE session_id = ? AND id = ?")
    .get(sessionId, turnId);
  if (turnRow === undefined) {
    return null;
  }
  const turn = conversationTurnSchema.parse(parsedJson(turnRow["payload_json"]));
  if (target.type === "turn") {
    const eventIds = turnEventIds(turn);
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
      rawEventsById(database, sessionId, eventIds),
    );
  }
  if (target.type === "message") {
    const message = [
      turn.userMessage,
      ...(turn.steeringMessages ?? []),
      ...turn.assistantMessages,
    ].find((candidate) => candidate?.id === target.id);
    return message === undefined || message === null
      ? null
      : messageInspector(turn, message, rawEventsById(database, sessionId, message.rawEventIds));
  }
  const activity = turn.activities.find(({ id }) => id === target.id);
  return activity === undefined
    ? null
    : activityInspector(turn, activity, rawEventsById(database, sessionId, activity.rawEventIds));
}
