import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type {
  ConversationActivity,
  ConversationTurn,
  RichTextDocument,
} from "../../shared/types/conversation.ts";
import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import {
  searchQuerySchema,
  searchResponseSchema,
  type CursorPage,
  type SearchHit,
  type SearchQuery,
} from "../../shared/types/repository.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";

interface SearchColumns {
  reasoning: string[];
  tools: string[];
  paths: string[];
}

function documentText(document: RichTextDocument | null): string {
  if (document === null) {
    return "";
  }
  const text: string[] = [];
  const visit = (nodes: RichTextDocument["children"]): void => {
    for (const node of nodes) {
      if (node.text !== undefined) {
        text.push(node.text);
      }
      if (node.children !== undefined) {
        visit(node.children);
      }
    }
  };
  visit(document.children);
  return text.join(" ");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function indexActivity(activity: ConversationActivity, columns: SearchColumns): void {
  switch (activity.kind) {
    case "reasoning":
      if (!activity.encrypted) {
        columns.reasoning.push(activity.summary, documentText(activity.body));
      } else {
        columns.reasoning.push(activity.summary);
      }
      break;
    case "tool":
      columns.tools.push(
        activity.namespace === null ? activity.name : `${activity.namespace}.${activity.name}`,
        activity.name,
        jsonText(activity.input),
        jsonText(activity.output),
        activity.error ?? "",
      );
      break;
    case "web_search":
      columns.tools.push("web_search", activity.query);
      break;
    case "patch":
      columns.tools.push("patch", activity.patch);
      columns.paths.push(...activity.affectedPaths);
      break;
    case "media":
      columns.paths.push(activity.sourcePath ?? "");
      break;
    default:
      break;
  }
}

function turnSearchColumns(turn: ConversationTurn): SearchColumns {
  const columns: SearchColumns = { reasoning: [], tools: [], paths: [] };
  for (const activity of turn.activities) {
    indexActivity(activity, columns);
  }
  return columns;
}

function sessionMetadata(session: NormalizedSession): string {
  const summary = session.summary;
  return jsonText({
    cwd: summary.cwd,
    gitBranch: summary.gitBranch,
    gitSha: summary.gitSha,
    gitOriginUrl: summary.gitOriginUrl,
    models: summary.models,
    reasoningEfforts: summary.reasoningEfforts,
    sectionName: summary.sectionName,
    parentThreadId: summary.parentThreadId,
    childThreadIds: summary.childThreadIds,
  });
}

function diagnosticText(diagnostics: readonly ViewerDiagnostic[]): string {
  return diagnostics
    .flatMap((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
      diagnostic.path ?? "",
      jsonText(diagnostic.details),
    ])
    .join("\n");
}

export function replaceSessionSearchRows(
  database: DatabaseSync,
  session: NormalizedSession,
  diagnostics: readonly ViewerDiagnostic[],
): void {
  database.prepare("DELETE FROM session_fts WHERE session_id = ?").run(session.summary.id);
  const insert = database.prepare(`
    INSERT INTO session_fts (
      session_id, turn_id, message_id, title, prompt, assistant, reasoning, tools,
      paths, metadata, diagnostics
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [index, turn] of session.turns.entries()) {
    const columns = turnSearchColumns(turn);
    const firstTurn = index === 0;
    insert.run(
      session.summary.id,
      turn.id,
      turn.userMessage?.id ?? turn.assistantMessages[0]?.id ?? null,
      firstTurn ? session.summary.title : "",
      turn.userMessage?.sourceMarkdown ?? "",
      turn.assistantMessages.map((message) => message.sourceMarkdown).join("\n"),
      columns.reasoning.join("\n"),
      columns.tools.join("\n"),
      columns.paths.join("\n"),
      [
        firstTurn ? sessionMetadata(session) : "",
        jsonText({ models: turn.models, reasoningEfforts: turn.reasoningEfforts }),
      ].join("\n"),
      firstTurn ? diagnosticText(diagnostics) : "",
    );
  }
}

function ftsExpression(query: string): string {
  return (query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []).map((term) => `"${term}"`).join(" AND ");
}

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d+$/u.test(cursor)) {
    throw new Error("Invalid search cursor.");
  }
  const offset = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(offset)) {
    throw new Error("Invalid search cursor.");
  }
  return offset;
}

function buildFilters(
  query: SearchQuery,
  expression: string,
): { sql: string; values: SQLInputValue[] } {
  const clauses = ["session_fts MATCH ?", "s.scope = ?"];
  const values: SQLInputValue[] = [expression, query.scope];
  if (query.model !== undefined) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(s.models_json) WHERE value = ?)");
    values.push(query.model);
  }
  if (query.cwd !== undefined) {
    clauses.push("s.cwd = ?");
    values.push(query.cwd);
  }
  if (query.tool !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(s.tool_counts_json) WHERE key = ? AND value > 0)",
    );
    values.push(query.tool);
  }
  if (query.hasMedia !== undefined) {
    clauses.push("s.has_media = ?");
    values.push(query.hasMedia ? 1 : 0);
  }
  return { sql: clauses.join(" AND "), values };
}

export function searchCachedSessions(
  database: DatabaseSync,
  input: SearchQuery,
): CursorPage<SearchHit> {
  const query = searchQuerySchema.parse(input);
  const limit = query.limit ?? 50;
  const offset = cursorOffset(query.cursor);
  const expression = ftsExpression(query.query);
  if (expression === "") {
    return { items: [], nextCursor: null, total: 0 };
  }
  const filters = buildFilters(query, expression);
  const totalRow = database
    .prepare(`
      SELECT count(*) AS total
      FROM session_fts
      JOIN sessions AS s ON s.id = session_fts.session_id
      WHERE ${filters.sql}
    `)
    .get(...filters.values);
  const total = Number(totalRow?.["total"] ?? 0);
  const rows = database
    .prepare(`
      SELECT
        session_fts.session_id,
        session_fts.turn_id,
        session_fts.message_id,
        s.scope,
        s.title,
        snippet(session_fts, -1, '', '', ' … ', 18) AS excerpt,
        rank
      FROM session_fts
      JOIN sessions AS s ON s.id = session_fts.session_id
      WHERE ${filters.sql}
      ORDER BY rank, s.updated_at DESC, session_fts.turn_id
      LIMIT ? OFFSET ?
    `)
    .all(...filters.values, limit, offset);
  return searchResponseSchema.parse({
    items: rows.map((row) => ({
      sessionId: row["session_id"],
      turnId: row["turn_id"],
      messageId: row["message_id"],
      scope: row["scope"],
      title: row["title"],
      excerpt: row["excerpt"],
      score: Math.max(0, -Number(row["rank"])),
    })),
    nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
    total,
  });
}
