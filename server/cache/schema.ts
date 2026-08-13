export const CACHE_SCHEMA_VERSION = 1;

export const INITIAL_CACHE_SCHEMA_SQL = `
  CREATE TABLE source_files (
    path TEXT PRIMARY KEY,
    session_id TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('active', 'archived')),
    size INTEGER NOT NULL CHECK (size >= 0),
    mtime_ms REAL NOT NULL CHECK (mtime_ms >= 0),
    device TEXT NOT NULL,
    inode TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    parsed_bytes INTEGER NOT NULL CHECK (parsed_bytes >= 0 AND parsed_bytes <= size),
    parser_version INTEGER NOT NULL CHECK (parser_version > 0),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('active', 'archived')),
    source_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cwd TEXT,
    git_branch TEXT,
    git_sha TEXT,
    git_origin_url TEXT,
    models_json TEXT NOT NULL,
    reasoning_efforts_json TEXT NOT NULL,
    turn_count INTEGER NOT NULL CHECK (turn_count >= 0),
    assistant_message_count INTEGER NOT NULL CHECK (assistant_message_count >= 0),
    tool_call_count INTEGER NOT NULL CHECK (tool_call_count >= 0),
    tool_counts_json TEXT NOT NULL,
    preview TEXT NOT NULL,
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    section_name TEXT,
    parent_thread_id TEXT,
    child_thread_ids_json TEXT NOT NULL,
    has_media INTEGER NOT NULL CHECK (has_media IN (0, 1)),
    diagnostic_count INTEGER NOT NULL CHECK (diagnostic_count >= 0),
    revision TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    FOREIGN KEY (source_path) REFERENCES source_files(path) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE TABLE turns (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
    started_at TEXT,
    completed_at TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    UNIQUE (session_id, turn_index),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE messages (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    phase TEXT,
    created_at TEXT NOT NULL,
    source_markdown TEXT NOT NULL,
    body_json TEXT NOT NULL,
    attachment_ids_json TEXT NOT NULL,
    raw_event_ids_json TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, turn_id) REFERENCES turns(session_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE activities (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, turn_id) REFERENCES turns(session_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE raw_events (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_order INTEGER NOT NULL CHECK (source_order >= 0),
    turn_id TEXT,
    type TEXT NOT NULL,
    timestamp TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, turn_id) REFERENCES turns(session_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    url TEXT,
    mime_type TEXT,
    byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
    sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    status TEXT NOT NULL CHECK (status IN ('available', 'missing', 'error')),
    original_path TEXT,
    cache_path TEXT,
    error TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE favicons (
    origin TEXT PRIMARY KEY,
    url TEXT,
    mime_type TEXT,
    byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
    sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
    cache_path TEXT,
    status TEXT NOT NULL CHECK (status IN ('available', 'missing', 'error')),
    fetched_at TEXT,
    error TEXT
  ) STRICT;

  CREATE TABLE diagnostics (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    code TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    area TEXT NOT NULL,
    message TEXT NOT NULL,
    path TEXT,
    recoverable INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
    created_at TEXT NOT NULL,
    details_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  ) STRICT;

  CREATE VIRTUAL TABLE session_fts USING fts5(
    session_id UNINDEXED,
    turn_id UNINDEXED,
    message_id UNINDEXED,
    title,
    prompt,
    assistant,
    reasoning,
    tools,
    paths,
    metadata,
    diagnostics,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE INDEX source_files_session_id_idx ON source_files(session_id);
  CREATE INDEX sessions_scope_updated_idx ON sessions(scope, updated_at DESC, id);
  CREATE INDEX turns_session_index_idx ON turns(session_id, turn_index);
  CREATE INDEX messages_turn_created_idx ON messages(turn_id, created_at, id);
  CREATE INDEX activities_turn_created_idx ON activities(turn_id, created_at, id);
  CREATE INDEX raw_events_session_order_idx ON raw_events(session_id, source_order);
  CREATE INDEX diagnostics_session_idx ON diagnostics(session_id);
`;
