import { DatabaseSync } from "node:sqlite";

export function createStateDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      first_user_message TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT,
      name TEXT,
      is_pinned INTEGER NOT NULL,
      thread_section_id TEXT,
      secret_blob TEXT
    );
    CREATE TABLE thread_sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    INSERT INTO thread_sections (id, name) VALUES ('section-1', 'Viewer');
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, tokens_used,
      archived, archived_at, git_sha, git_branch, git_origin_url, first_user_message, model,
      reasoning_effort, name, is_pinned, thread_section_id, secret_blob
    ) VALUES (
      'thread-1', 'sessions/rollout-thread-1.jsonl', 100, 200, 'vscode', 'openai', 'C:/repo',
      'Fallback title', 1234, 0, NULL, 'abc123', 'main', 'https://example.test/repo.git',
      'First prompt', 'gpt-test', 'high', 'Chosen name', 1, 'section-1', 'must-not-leak'
    );
    INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
    VALUES ('thread-1', 'thread-2', 'closed');
  `);
  return database;
}
