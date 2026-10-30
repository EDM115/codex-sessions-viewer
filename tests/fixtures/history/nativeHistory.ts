import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ResolvedRolloutLineage } from "#server/ingestion/rolloutLineage.ts";
import type { RolloutRef } from "#shared/types/conversation.ts";

export const HISTORY_FIXTURE_SCHEMA = `
CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);
CREATE TABLE thread_turns(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER, root_turn_id TEXT, PRIMARY KEY(thread_id,turn_id));
CREATE UNIQUE INDEX idx_thread_turns_page ON thread_turns(thread_id,rollout_ordinal,turn_id);
CREATE TABLE thread_items(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0, started_at_ms INTEGER, completed_at_ms INTEGER, PRIMARY KEY(thread_id,turn_id,item_id));
CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id,rollout_ordinal,turn_id,item_id);
CREATE INDEX idx_thread_items_by_turn_page ON thread_items(thread_id,turn_id,rollout_ordinal,item_id);
CREATE INDEX idx_thread_items_by_turn_updated_page ON thread_items(thread_id,turn_id,updated_at_ordinal,item_id);
`;
export function addTurn(
  database: DatabaseSync,
  physical = "physical",
  turn = "turn",
  ordinal = 1,
  end: number | null = 4,
) {
  database
    .prepare(
      "INSERT INTO thread_turns(thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,duration_ms,first_user_item_id,final_agent_item_id,rollout_end_ordinal) VALUES(?,?,?,'completed',100,200,100,'user','answer',?)",
    )
    .run(physical, turn, ordinal, end);
}
export function addItem(
  database: DatabaseSync,
  id: string,
  ordinal: number,
  payload: { type: string; [key: string]: unknown },
  physical = "physical",
  turn = "turn",
  updated = ordinal,
) {
  database
    .prepare(
      "INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type,updated_at_ordinal) VALUES(?,?,?,?,100,?,?,?)",
    )
    .run(physical, turn, id, ordinal, JSON.stringify(payload), payload.type, updated);
}
export function fixtureRef(path: string, physical = "physical", stable = "stable"): RolloutRef {
  return {
    codexHomeId: "home",
    stableThreadId: stable,
    physicalRolloutId: physical,
    rootSessionId: "root",
    sourcePath: path,
    representation: "plain-jsonl",
    historyBase: null,
    subagentHistoryStartOrdinal: null,
  };
}
export function fixtureLineage(ref: RolloutRef): ResolvedRolloutLineage {
  return {
    status: "complete",
    historyEpoch: "fixture-lineage",
    diagnostics: [],
    segments: [
      {
        ref,
        bodyStartOrdinal: 1,
        displayStartOrdinal: 1,
        endOrdinalExclusive: null,
        endByteOffset: null,
      },
    ],
  };
}
export function canonicalRecords(
  text = "answer A",
): { type: string; payload: Record<string, unknown> }[] {
  return [
    { type: "session_meta", payload: { id: "stable", session_id: "root" } },
    { type: "event_msg", payload: { type: "turn_started", turn_id: "turn", started_at: 100 } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: { type: "UserMessage", id: "user", content: [{ type: "text", text: "question" }] },
        completed_at_ms: 0,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: {
          type: "AgentMessage",
          id: "answer",
          content: [{ type: "Text", text }],
          phase: "final_answer",
        },
        completed_at_ms: 0,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "turn_complete",
        turn_id: "turn",
        started_at: 100,
        completed_at: 200,
        duration_ms: 100,
      },
    },
  ];
}
export async function historyFixture(root: string) {
  await mkdir(root, { recursive: true });
  const sourceDatabase = join(root, "thread_history_1.sqlite");
  const rollout = join(root, "rollout.jsonl");
  const raw =
    canonicalRecords()
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
  await writeFile(rollout, raw);
  const database = new DatabaseSync(sourceDatabase);
  database.exec(HISTORY_FIXTURE_SCHEMA);
  addTurn(database);
  addItem(database, "user", 2, {
    type: "userMessage",
    id: "user",
    clientId: null,
    content: [{ type: "text", text: "question" }],
  });
  addItem(database, "answer", 3, {
    type: "agentMessage",
    id: "answer",
    text: "answer A",
    phase: "final_answer",
  });
  database
    .prepare("INSERT INTO thread_history_projection_state VALUES(?,?,?)")
    .run("physical", Buffer.byteLength(raw), 5);
  database.close();
  return {
    sourceDatabase,
    sourceWal: `${sourceDatabase}-wal`,
    snapshotRoot: join(root, "owned-snapshots"),
    rollout,
    ref: fixtureRef(rollout),
    raw,
  };
}
