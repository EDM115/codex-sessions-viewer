import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import * as z from "zod";

import {
  conversationSummarySchema,
  conversationTurnSchema,
  jsonValueSchema,
  type ConversationMessage,
  type ConversationScope,
  type ConversationTurn,
  type SourceFingerprint,
} from "../../shared/types/conversation.ts";
import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import { guardianActionHash } from "../normalization/guardianEvidence.ts";
import {
  type NormalizedRawEvent,
  type NormalizedSession,
} from "../normalization/normalizeSession.ts";
import { catalogSession, markCatalogSessionReady } from "./catalogStore.ts";
import { withCacheTransaction } from "./database.ts";
import { replaceSessionSearchRows } from "./searchStore.ts";

export interface CachedSourceWrite {
  fingerprint: SourceFingerprint;
  scope: ConversationScope;
  identity: { device: bigint; inode: bigint };
}

export interface ReplaceCachedSessionInput {
  session: NormalizedSession;
  diagnostics: readonly ViewerDiagnostic[];
  source: CachedSourceWrite;
  expectedCatalogSourceRevision?: string | undefined;
  previousSession?: NormalizedSession | undefined;
}

export type ReplaceCachedSessionResult =
  | { status: "committed"; changedTurnIds: string[] }
  | { status: "stale-catalog" };

class StaleCatalogCommitError extends Error {}

const rawEventSchema = z.strictObject({
  id: z.string().min(1),
  turnId: z.string().nullable(),
  type: z.string().min(1),
  timestamp: z.string().nullable(),
  payload: jsonValueSchema,
});

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new Error("The viewer cache contains a non-text JSON value.");
  }
  return JSON.parse(value) as unknown;
}

function writeSource(database: DatabaseSync, sessionId: string, source: CachedSourceWrite): void {
  const fingerprint = source.fingerprint;
  database
    .prepare(`
      INSERT INTO source_files (
        path, session_id, scope, size, mtime_ms, device, inode, sha256, parsed_bytes,
        parser_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        session_id = excluded.session_id,
        scope = excluded.scope,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        device = excluded.device,
        inode = excluded.inode,
        sha256 = excluded.sha256,
        parsed_bytes = excluded.parsed_bytes,
        parser_version = excluded.parser_version,
        updated_at = excluded.updated_at
    `)
    .run(
      fingerprint.path,
      sessionId,
      source.scope,
      fingerprint.size,
      fingerprint.mtimeMs,
      source.identity.device.toString(),
      source.identity.inode.toString(),
      fingerprint.sha256,
      fingerprint.parsedBytes,
      fingerprint.parserVersion,
      new Date().toISOString(),
    );
}

function writeSummary(database: DatabaseSync, session: NormalizedSession): void {
  const summary = conversationSummarySchema.parse(session.summary);
  database
    .prepare(`
      INSERT INTO sessions (
        id, title, scope, source_path, created_at, updated_at, cwd, git_branch, git_sha,
        git_origin_url, models_json, reasoning_efforts_json, turn_count,
        assistant_message_count, tool_call_count, tool_counts_json, preview, pinned,
        section_name, parent_thread_id, child_thread_ids_json, has_media, diagnostic_count,
        revision, summary_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        scope = excluded.scope,
        source_path = excluded.source_path,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        cwd = excluded.cwd,
        git_branch = excluded.git_branch,
        git_sha = excluded.git_sha,
        git_origin_url = excluded.git_origin_url,
        models_json = excluded.models_json,
        reasoning_efforts_json = excluded.reasoning_efforts_json,
        turn_count = excluded.turn_count,
        assistant_message_count = excluded.assistant_message_count,
        tool_call_count = excluded.tool_call_count,
        tool_counts_json = excluded.tool_counts_json,
        preview = excluded.preview,
        pinned = excluded.pinned,
        section_name = excluded.section_name,
        parent_thread_id = excluded.parent_thread_id,
        child_thread_ids_json = excluded.child_thread_ids_json,
        has_media = excluded.has_media,
        diagnostic_count = excluded.diagnostic_count,
        revision = excluded.revision,
        summary_json = excluded.summary_json
    `)
    .run(
      summary.id,
      summary.title,
      summary.scope,
      summary.sourcePath,
      summary.createdAt,
      summary.updatedAt,
      summary.cwd,
      summary.gitBranch,
      summary.gitSha,
      summary.gitOriginUrl,
      json(summary.models),
      json(summary.reasoningEfforts),
      summary.turnCount,
      summary.assistantMessageCount,
      summary.toolCallCount,
      json(summary.toolCounts),
      summary.preview,
      summary.pinned ? 1 : 0,
      summary.sectionName,
      summary.parentThreadId,
      json(summary.childThreadIds),
      summary.hasMedia ? 1 : 0,
      summary.diagnosticCount,
      summary.revision,
      json(summary),
    );
}

function writeMessage(
  statement: ReturnType<DatabaseSync["prepare"]>,
  sessionId: string,
  message: ConversationMessage,
): void {
  statement.run(
    message.id,
    sessionId,
    message.turnId,
    message.role,
    message.phase,
    message.createdAt,
    message.sourceMarkdown,
    json(message.body),
    json(message.attachmentIds),
    json(message.rawEventIds),
  );
}

function preserveRichTurn(
  previous: ConversationTurn,
  current: ConversationTurn,
  stored: ConversationTurn,
): ConversationTurn {
  const previousMessages = new Map(
    [previous.userMessage, ...(previous.steeringMessages ?? []), ...previous.assistantMessages]
      .filter((message) => message !== null)
      .map((message) => [message.id, message]),
  );
  const storedMessages = new Map(
    [stored.userMessage, ...(stored.steeringMessages ?? []), ...stored.assistantMessages]
      .filter((message) => message !== null)
      .map((message) => [message.id, message]),
  );
  const preserveMessage = (message: ConversationMessage): ConversationMessage => {
    const before = previousMessages.get(message.id);
    const rich = storedMessages.get(message.id);
    return before !== undefined &&
      rich !== undefined &&
      before.sourceMarkdown === message.sourceMarkdown &&
      json(before.attachmentIds) === json(message.attachmentIds)
      ? { ...message, body: rich.body }
      : message;
  };
  const previousActivities = new Map(
    previous.activities.map((activity) => [activity.id, activity]),
  );
  const storedActivities = new Map(stored.activities.map((activity) => [activity.id, activity]));
  return {
    ...current,
    userMessage: current.userMessage === null ? null : preserveMessage(current.userMessage),
    steeringMessages: (current.steeringMessages ?? []).map(preserveMessage),
    assistantMessages: current.assistantMessages.map(preserveMessage),
    activities: current.activities.map((activity) =>
      json(previousActivities.get(activity.id)) === json(activity)
        ? (storedActivities.get(activity.id) ?? activity)
        : activity,
    ),
  };
}

function replaceChildren(
  database: DatabaseSync,
  session: NormalizedSession,
  previous?: NormalizedSession,
): string[] {
  const sessionId = session.summary.id;
  const priorTurns = new Map(previous?.turns.map((turn) => [turn.id, turn]));
  const currentIds = new Set(session.turns.map(({ id }) => id));
  const changed = new Set(
    session.turns
      .filter(
        (turn) => priorTurns.get(turn.id) !== turn && json(priorTurns.get(turn.id)) !== json(turn),
      )
      .map(({ id }) => id),
  );
  for (const id of priorTurns.keys()) {
    if (!currentIds.has(id)) {
      changed.add(id);
    }
  }
  const preserved = new Map<string, ConversationTurn>();
  const readTurn = database.prepare(
    "SELECT payload_json FROM turns WHERE session_id = ? AND id = ?",
  );
  for (const turn of session.turns) {
    const prior = priorTurns.get(turn.id);
    if (!changed.has(turn.id) || prior === undefined) {
      continue;
    }
    const row = readTurn.get(sessionId, turn.id);
    if (row !== undefined) {
      preserved.set(
        turn.id,
        preserveRichTurn(
          prior,
          turn,
          conversationTurnSchema.parse(parsedJson(row["payload_json"])),
        ),
      );
    }
  }
  database.prepare("DELETE FROM diagnostics WHERE session_id = ?").run(sessionId);
  if (previous === undefined) {
    database.prepare("DELETE FROM raw_events WHERE session_id = ?").run(sessionId);
    database.prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
  } else {
    const remove = database.prepare("DELETE FROM turns WHERE session_id = ? AND id = ?");
    for (const id of changed) {
      remove.run(sessionId, id);
    }
  }

  const insertTurn = database.prepare(`
    INSERT INTO turns (id, session_id, turn_index, started_at, completed_at, payload_json, final_assistant_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = database.prepare(`
    INSERT INTO messages (
      id, session_id, turn_id, role, phase, created_at, source_markdown, body_json,
      attachment_ids_json, raw_event_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertActivity = database.prepare(`
    INSERT INTO activities (id, session_id, turn_id, kind, created_at, payload_json, guardian_input_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const normalizedTurn of session.turns) {
    if (!changed.has(normalizedTurn.id)) {
      continue;
    }
    const turn = preserved.get(normalizedTurn.id) ?? normalizedTurn;
    insertTurn.run(
      turn.id,
      sessionId,
      turn.index,
      turn.startedAt,
      turn.completedAt,
      json(turn),
      turn.finalAssistantMessageId ?? null,
    );
    if (turn.userMessage !== null) {
      writeMessage(insertMessage, sessionId, turn.userMessage);
    }
    for (const message of turn.steeringMessages ?? []) {
      writeMessage(insertMessage, sessionId, message);
    }
    for (const message of turn.assistantMessages) {
      writeMessage(insertMessage, sessionId, message);
    }
    for (const activity of turn.activities) {
      insertActivity.run(
        activity.id,
        sessionId,
        turn.id,
        activity.kind,
        activity.createdAt,
        json(activity),
        activity.kind === "tool" ? guardianActionHash(activity.input) : null,
      );
    }
  }

  const insertRawEvent = database.prepare(`
    INSERT INTO raw_events (
      id, session_id, source_order, turn_id, type, timestamp, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO UPDATE SET source_order = excluded.source_order, turn_id = excluded.turn_id, type = excluded.type, timestamp = excluded.timestamp, payload_json = excluded.payload_json
  `);
  const priorEvents = new Map(previous?.rawEvents.map((event) => [event.id, event]));
  session.rawEvents.forEach((event, index) => {
    const before = priorEvents.get(event.id);
    if (
      before !== undefined &&
      !changed.has(event.turnId ?? "") &&
      before.turnId === event.turnId &&
      before.payload === event.payload &&
      before.type === event.type &&
      before.timestamp === event.timestamp
    ) {
      return;
    }
    insertRawEvent.run(
      event.id,
      sessionId,
      index,
      event.turnId,
      event.type,
      event.timestamp,
      json(event.payload),
    );
  });
  return [...changed];
}

function writeDiagnostics(
  database: DatabaseSync,
  sessionId: string,
  diagnostics: readonly ViewerDiagnostic[],
): void {
  const insert = database.prepare(`
    INSERT INTO diagnostics (
      id, session_id, code, severity, area, message, path, recoverable, created_at, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const diagnostic of diagnostics) {
    insert.run(
      diagnostic.id,
      diagnostic.sessionId ?? sessionId,
      diagnostic.code,
      diagnostic.severity,
      diagnostic.area,
      diagnostic.message,
      diagnostic.path,
      diagnostic.recoverable ? 1 : 0,
      diagnostic.createdAt,
      json(diagnostic.details),
    );
  }
}

export function replaceCachedSession(
  database: DatabaseSync,
  input: ReplaceCachedSessionInput,
): ReplaceCachedSessionResult {
  try {
    return withCacheTransaction(database, () => {
      const expectedRevision = input.expectedCatalogSourceRevision;
      if (expectedRevision !== undefined) {
        const catalog = catalogSession(database, input.session.summary.id);
        if (
          catalog === null ||
          catalog.kind === "auxiliary" ||
          catalog.sourceRevision !== expectedRevision ||
          catalog.summary.sourcePath !== input.source.fingerprint.path ||
          input.session.summary.sourcePath !== input.source.fingerprint.path
        ) {
          return { status: "stale-catalog" };
        }
      }
      const previous = input.previousSession;
      const storedRevision = database
        .prepare("SELECT revision FROM sessions WHERE id = ?")
        .get(input.session.summary.id)?.["revision"];
      const reusablePrevious = previous?.summary.revision === storedRevision ? previous : undefined;
      writeSource(database, input.session.summary.id, input.source);
      writeSummary(database, input.session);
      const markedReady = markCatalogSessionReady(
        database,
        input.session.summary,
        expectedRevision === undefined
          ? undefined
          : {
              sourceRevision: expectedRevision,
              sourcePath: input.source.fingerprint.path,
            },
      );
      if (expectedRevision !== undefined && !markedReady) {
        throw new StaleCatalogCommitError();
      }
      const changedTurnIds = replaceChildren(database, input.session, reusablePrevious);
      writeDiagnostics(database, input.session.summary.id, input.diagnostics);
      replaceSessionSearchRows(
        database,
        input.session,
        input.diagnostics,
        reusablePrevious === undefined ? undefined : changedTurnIds,
      );
      return { status: "committed", changedTurnIds };
    });
  } catch (error) {
    if (error instanceof StaleCatalogCommitError) {
      return { status: "stale-catalog" };
    }
    throw error;
  }
}

export function updateCachedSessionRichContent(
  database: DatabaseSync,
  session: NormalizedSession,
): void {
  withCacheTransaction(database, () => {
    const revision = database
      .prepare("SELECT revision FROM sessions WHERE id = ?")
      .get(session.summary.id)?.["revision"];
    if (revision !== session.summary.revision) {
      throw new Error("Refusing to cache rich content for a stale session revision.");
    }
    const updateTurn = database.prepare(`
      UPDATE turns SET payload_json = ?, rich_revision = ? WHERE session_id = ? AND id = ?
    `);
    const updateMessage = database.prepare(`
      UPDATE messages SET body_json = ? WHERE session_id = ? AND id = ?
    `);
    const updateActivity = database.prepare(`
      UPDATE activities SET payload_json = ? WHERE session_id = ? AND id = ?
    `);
    for (const turn of session.turns) {
      const validatedTurn = conversationTurnSchema.parse(turn);
      if (
        updateTurn.run(json(validatedTurn), session.summary.revision, session.summary.id, turn.id)
          .changes !== 1
      ) {
        throw new Error("The cached session turn changed while rich content was being stored.");
      }
      const messages = [
        turn.userMessage,
        ...(turn.steeringMessages ?? []),
        ...turn.assistantMessages,
      ].filter((message): message is ConversationMessage => message !== null);
      for (const message of messages) {
        if (updateMessage.run(json(message.body), session.summary.id, message.id).changes !== 1) {
          throw new Error(
            "The cached session message changed while rich content was being stored.",
          );
        }
      }
      for (const activity of turn.activities) {
        if (updateActivity.run(json(activity), session.summary.id, activity.id).changes !== 1) {
          throw new Error(
            "The cached session activity changed while rich content was being stored.",
          );
        }
      }
    }
  });
}

function requiredText(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`The viewer cache column ${key} is not text.`);
  }
  return value;
}

export function getCachedSession(
  database: DatabaseSync,
  sessionId: string,
  options: { includeRawEvents?: boolean } = {},
): NormalizedSession | null {
  const summaryRow = database
    .prepare("SELECT summary_json FROM sessions WHERE id = ?")
    .get(sessionId);
  if (summaryRow === undefined) {
    return null;
  }
  const summary = conversationSummarySchema.parse(parsedJson(summaryRow["summary_json"]));
  const turns = database
    .prepare("SELECT payload_json FROM turns WHERE session_id = ? ORDER BY turn_index")
    .all(sessionId)
    .map((row) => conversationTurnSchema.parse(parsedJson(row["payload_json"])));
  const rawEvents: NormalizedRawEvent[] =
    options.includeRawEvents === false
      ? []
      : database
          .prepare(`
            SELECT id, turn_id, type, timestamp, payload_json
            FROM raw_events
            WHERE session_id = ?
            ORDER BY source_order
          `)
          .all(sessionId)
          .map((row) =>
            rawEventSchema.parse({
              id: requiredText(row, "id"),
              turnId: row["turn_id"],
              type: requiredText(row, "type"),
              timestamp: row["timestamp"],
              payload: parsedJson(row["payload_json"]),
            }),
          );
  return { summary, turns, rawEvents };
}

export function hasCachedSession(
  database: DatabaseSync,
  sessionId: string,
  parserVersion?: number,
): boolean {
  return parserVersion === undefined
    ? database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) !== undefined
    : database
        .prepare(
          "SELECT 1 FROM sessions JOIN source_files ON source_files.path = sessions.source_path WHERE sessions.id = ? AND source_files.parser_version = ?",
        )
        .get(sessionId, parserVersion) !== undefined;
}

export function removeCachedSource(database: DatabaseSync, sourcePath: string): string | null {
  return withCacheTransaction(database, () => {
    const source = database
      .prepare("SELECT session_id FROM source_files WHERE path = ?")
      .get(sourcePath);
    if (source === undefined) {
      return null;
    }
    const sessionId = typeof source["session_id"] === "string" ? source["session_id"] : null;
    if (sessionId !== null) {
      const session = database
        .prepare("SELECT source_path FROM sessions WHERE id = ?")
        .get(sessionId);
      if (session?.["source_path"] === sourcePath) {
        database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      }
    }
    database.prepare("DELETE FROM session_catalog WHERE source_path = ?").run(sourcePath);
    database.prepare("DELETE FROM source_files WHERE path = ?").run(sourcePath);
    return sessionId;
  });
}

export function listCachedSourcePaths(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT path FROM source_files ORDER BY path")
    .all()
    .map((row) => requiredText(row, "path"));
}
