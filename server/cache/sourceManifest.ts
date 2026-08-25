import { createHash, type Hash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type { ConversationScope, SourceFingerprint } from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { DiscoveredRolloutSource } from "../ingestion/discoverSources.ts";
import {
  readStableJsonl,
  type JsonlParseError,
  type JsonlParserState,
  type JsonlRecord,
  type ReadStableJsonlOptions,
  type StableJsonlResult,
} from "../ingestion/jsonlStream.ts";
import { stableRead, type SourceIdentity } from "../ingestion/stableRead.ts";
import type { SessionIndexEntry } from "../metadata/sessionIndex.ts";
import type { StateMetadataSnapshot } from "../metadata/stateSnapshot.ts";
import {
  NORMALIZATION_PARSER_VERSION,
  normalizeSession,
  type NormalizeSessionInput,
  type NormalizeSessionResult,
} from "../normalization/normalizeSession.ts";
import { replaceCachedSession } from "./conversationStore.ts";

export const CACHE_PARSER_VERSION = NORMALIZATION_PARSER_VERSION;
const PREFIX_PROBE_BYTES = 64;

export interface SourceManifestEntry {
  path: string;
  sessionId: string | null;
  scope: ConversationScope;
  fingerprint: SourceFingerprint;
  identity: SourceIdentity;
}

export type StableJsonlReader = (
  path: string,
  options: ReadStableJsonlOptions,
) => Promise<StableJsonlResult>;

export interface SessionCacheUpdaterOptions {
  parserVersion?: number | undefined;
  retainLiveSources?: boolean | undefined;
  normalize?: ((input: NormalizeSessionInput) => NormalizeSessionResult) | undefined;
  readJsonl?: StableJsonlReader | undefined;
  sessionIndexEntries?: SessionIndexEntry[] | undefined;
  stateSnapshot?: StateMetadataSnapshot | null | undefined;
}

export interface SessionCacheUpdateContext {
  force?: boolean | undefined;
  expectedCatalogSessionId?: string | undefined;
  expectedCatalogSourceRevision?: string | undefined;
  sessionIndexEntries?: SessionIndexEntry[] | undefined;
  stateSnapshot?: StateMetadataSnapshot | null | undefined;
}

export type SessionCacheUpdateResult =
  | {
      status: "unchanged";
      sessionId: string | null;
      fingerprint: SourceFingerprint;
    }
  | {
      status: "updated";
      mode: "full" | "append" | "memory";
      sessionId: string;
      fingerprint: SourceFingerprint;
      diagnostics: ViewerDiagnostic[];
    }
  | {
      status: "failed";
      retainedSessionId: string | null;
      diagnostics: ViewerDiagnostic[];
    }
  | {
      status: "stale-catalog";
      sessionId: string;
      fingerprint: SourceFingerprint;
      retainedSessionId: string;
      diagnostics: [];
    };

interface ObservedSource {
  size: number;
  mtimeMs: number;
  identity: SourceIdentity;
}

interface LiveSourceState {
  fingerprint: SourceFingerprint;
  identity: SourceIdentity;
  hash: Hash;
  parserState: JsonlParserState;
  records: JsonlRecord[];
  errors: JsonlParseError[];
  prefixProbe: Buffer;
}

interface ReadCandidate extends LiveSourceState {
  mode: "full" | "append";
}

function outputText(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`The viewer cache source manifest column ${key} is not text.`);
  }
  return value;
}

function outputNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`The viewer cache source manifest column ${key} is not numeric.`);
  }
  return value;
}

export function getSourceManifestEntry(
  database: DatabaseSync,
  path: string,
): SourceManifestEntry | null {
  const row = database.prepare("SELECT * FROM source_files WHERE path = ?").get(path);
  if (row === undefined) {
    return null;
  }
  const scope = outputText(row, "scope");
  if (scope !== "active" && scope !== "archived") {
    throw new Error("The viewer cache source manifest contains an invalid scope.");
  }
  const sessionId = row["session_id"];
  if (sessionId !== null && typeof sessionId !== "string") {
    throw new Error("The viewer cache source manifest contains an invalid session ID.");
  }
  return {
    path,
    sessionId,
    scope,
    identity: {
      device: BigInt(outputText(row, "device")),
      inode: BigInt(outputText(row, "inode")),
    },
    fingerprint: {
      path,
      size: outputNumber(row, "size"),
      mtimeMs: outputNumber(row, "mtime_ms"),
      sha256: outputText(row, "sha256"),
      parsedBytes: outputNumber(row, "parsed_bytes"),
      parserVersion: outputNumber(row, "parser_version"),
    },
  };
}

async function observeSource(path: string): Promise<ObservedSource> {
  const stats = await stat(path, { bigint: true });
  const size = Number(stats.size);
  if (!Number.isSafeInteger(size)) {
    throw new RangeError("Source file is too large to address safely");
  }
  return {
    size,
    mtimeMs: Number(stats.mtimeNs) / 1_000_000,
    identity: { device: stats.dev, inode: stats.ino },
  };
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function matchesFingerprint(
  entry: SourceManifestEntry,
  observed: ObservedSource,
  parserVersion: number,
): boolean {
  return (
    entry.fingerprint.size === observed.size &&
    entry.fingerprint.mtimeMs === observed.mtimeMs &&
    entry.fingerprint.parserVersion === parserVersion &&
    sameIdentity(entry.identity, observed.identity)
  );
}

async function verifyTouchedSource(
  entry: SourceManifestEntry,
  observed: ObservedSource,
  parserVersion: number,
): Promise<SourceFingerprint | null> {
  if (
    entry.fingerprint.parserVersion !== parserVersion ||
    entry.fingerprint.size !== observed.size ||
    !sameIdentity(entry.identity, observed.identity)
  ) {
    return null;
  }
  const hash = createHash("sha256");
  const read = await stableRead(entry.path, {
    onChunk({ bytes }) {
      hash.update(bytes);
    },
  });
  if (
    read.status !== "stable" ||
    read.size !== entry.fingerprint.size ||
    hash.digest("hex") !== entry.fingerprint.sha256
  ) {
    return null;
  }
  return {
    ...entry.fingerprint,
    mtimeMs: read.mtimeMs,
  };
}

function storeTouchedSourceFingerprint(
  database: DatabaseSync,
  entry: SourceManifestEntry,
  fingerprint: SourceFingerprint,
): void {
  const updated = database
    .prepare(`
      UPDATE source_files
      SET mtime_ms = ?, updated_at = ?
      WHERE path = ? AND sha256 = ? AND parser_version = ?
    `)
    .run(
      fingerprint.mtimeMs,
      new Date().toISOString(),
      entry.path,
      entry.fingerprint.sha256,
      entry.fingerprint.parserVersion,
    );
  if (updated.changes !== 1) {
    throw new Error("The cached source fingerprint changed while its mtime was being refreshed.");
  }
}

export async function refreshUnchangedSourceManifest(
  database: DatabaseSync,
  path: string,
  expectedSessionId: string,
): Promise<boolean> {
  const entry = getSourceManifestEntry(database, path);
  if (entry === null || entry.sessionId !== expectedSessionId) {
    return false;
  }
  try {
    const observed = await observeSource(path);
    if (matchesFingerprint(entry, observed, CACHE_PARSER_VERSION)) {
      return true;
    }
    const fingerprint = await verifyTouchedSource(entry, observed, CACHE_PARSER_VERSION);
    if (fingerprint === null) {
      return false;
    }
    storeTouchedSourceFingerprint(database, entry, fingerprint);
    clearSourceFailureDiagnostics(database, path);
    return true;
  } catch {
    return false;
  }
}

function appendProbe(previous: Buffer, bytes: Uint8Array): Buffer {
  const chunk = Buffer.from(bytes);
  if (chunk.byteLength >= PREFIX_PROBE_BYTES) {
    return Buffer.from(chunk.subarray(chunk.byteLength - PREFIX_PROBE_BYTES));
  }
  const combined = Buffer.concat([previous, chunk]);
  return Buffer.from(combined.subarray(Math.max(0, combined.byteLength - PREFIX_PROBE_BYTES)));
}

function changedDuringRead(path: string): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "source.changed_during_read",
    severity: "warning",
    area: "source",
    message:
      "The Codex session changed while it was being read; the last good cached revision was retained.",
    path,
  });
}

function cacheFailure(path: string, error: unknown): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "cache.unavailable",
    severity: "warning",
    area: "cache",
    message:
      "The viewer could not update this session cache; the last good cached revision was retained.",
    path,
    details: { error: error instanceof Error ? error.message : String(error) },
  });
}

function parseErrors(path: string, errors: readonly JsonlParseError[]): ViewerDiagnostic[] {
  if (errors.length === 0) {
    return [];
  }
  return [
    createViewerDiagnostic({
      code: "source.invalid_jsonl",
      severity: "warning",
      area: "source",
      message: `${errors.length} malformed JSONL record${errors.length === 1 ? " was" : "s were"} skipped.`,
      path,
      details: { lines: errors.map((error) => error.lineNumber) },
    }),
  ];
}

function replaceSourceFailureDiagnostics(
  database: DatabaseSync,
  path: string,
  diagnostics: readonly ViewerDiagnostic[],
): void {
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare("DELETE FROM diagnostics WHERE session_id IS NULL AND path = ?").run(path);
    const insert = database.prepare(`
      INSERT INTO diagnostics (
        id, session_id, code, severity, area, message, path, recoverable, created_at, details_json
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const diagnostic of diagnostics) {
      insert.run(
        `${diagnostic.id}:source-failure`,
        diagnostic.code,
        diagnostic.severity,
        diagnostic.area,
        diagnostic.message,
        path,
        diagnostic.recoverable ? 1 : 0,
        diagnostic.createdAt,
        JSON.stringify(diagnostic.details),
      );
    }
    database.exec("COMMIT");
  } catch {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
  }
}

function clearSourceFailureDiagnostics(database: DatabaseSync, path: string): void {
  try {
    database.prepare("DELETE FROM diagnostics WHERE session_id IS NULL AND path = ?").run(path);
  } catch {
    // A cache cleanup failure must not make a successfully parsed Codex source unavailable.
  }
}

export class SessionCacheUpdater {
  readonly #database: DatabaseSync;
  readonly #parserVersion: number;
  readonly #normalize: (input: NormalizeSessionInput) => NormalizeSessionResult;
  readonly #readJsonl: StableJsonlReader;
  readonly #retainLiveSources: boolean;
  readonly #defaultSessionIndexEntries: SessionIndexEntry[];
  readonly #defaultStateSnapshot: StateMetadataSnapshot | null;
  readonly #liveSources = new Map<string, LiveSourceState>();

  constructor(database: DatabaseSync, options: SessionCacheUpdaterOptions = {}) {
    this.#database = database;
    this.#parserVersion = options.parserVersion ?? CACHE_PARSER_VERSION;
    this.#normalize = options.normalize ?? normalizeSession;
    this.#readJsonl = options.readJsonl ?? readStableJsonl;
    this.#retainLiveSources = options.retainLiveSources ?? true;
    this.#defaultSessionIndexEntries = options.sessionIndexEntries ?? [];
    this.#defaultStateSnapshot = options.stateSnapshot ?? null;
    if (!Number.isSafeInteger(this.#parserVersion) || this.#parserVersion <= 0) {
      throw new RangeError("The cache parser version must be a positive safe integer.");
    }
  }

  async #readFull(source: DiscoveredRolloutSource): Promise<ReadCandidate | null> {
    const hash = createHash("sha256");
    let prefixProbe: Buffer = Buffer.alloc(0);
    const result = await this.#readJsonl(source.path, {
      start: 0,
      afterChunk(chunk) {
        hash.update(chunk.bytes);
        prefixProbe = appendProbe(prefixProbe, chunk.bytes);
      },
    });
    if (result.read.status !== "stable") {
      return null;
    }
    const observed = await observeSource(source.path);
    if (
      result.read.size !== observed.size ||
      result.read.mtimeMs !== observed.mtimeMs ||
      !sameIdentity(result.read.identity, observed.identity)
    ) {
      return null;
    }
    return {
      mode: "full",
      fingerprint: {
        path: source.path,
        size: observed.size,
        mtimeMs: result.read.mtimeMs,
        sha256: hash.copy().digest("hex"),
        parsedBytes: result.state.pendingStart,
        parserVersion: this.#parserVersion,
      },
      identity: observed.identity,
      hash,
      parserState: result.state,
      records: result.records,
      errors: result.errors,
      prefixProbe,
    };
  }

  async #readAppend(
    source: DiscoveredRolloutSource,
    live: LiveSourceState,
  ): Promise<ReadCandidate | null> {
    const hash = live.hash.copy();
    let prefixProbe: Buffer = Buffer.from(live.prefixProbe);
    const result = await this.#readJsonl(source.path, {
      start: live.fingerprint.size,
      state: live.parserState,
      expectedPrefix: {
        offset: live.fingerprint.size - live.prefixProbe.byteLength,
        bytes: live.prefixProbe,
      },
      afterChunk(chunk) {
        hash.update(chunk.bytes);
        prefixProbe = appendProbe(prefixProbe, chunk.bytes);
      },
    });
    if (result.read.status === "full-reparse") {
      return this.#readFull(source);
    }
    if (result.read.status !== "stable") {
      return null;
    }
    const observed = await observeSource(source.path);
    if (
      result.read.size !== observed.size ||
      result.read.mtimeMs !== observed.mtimeMs ||
      !sameIdentity(result.read.identity, observed.identity)
    ) {
      return null;
    }
    return {
      mode: "append",
      fingerprint: {
        path: source.path,
        size: observed.size,
        mtimeMs: result.read.mtimeMs,
        sha256: hash.copy().digest("hex"),
        parsedBytes: result.state.pendingStart,
        parserVersion: this.#parserVersion,
      },
      identity: observed.identity,
      hash,
      parserState: result.state,
      records: [...live.records, ...result.records],
      errors: [...live.errors, ...result.errors],
      prefixProbe,
    };
  }

  #normalizeAndStore(
    source: DiscoveredRolloutSource,
    candidate: ReadCandidate | LiveSourceState,
    mode: "full" | "append" | "memory",
    context: SessionCacheUpdateContext,
  ): SessionCacheUpdateResult {
    const normalized = this.#normalize({
      records: candidate.records,
      sourcePath: source.path,
      scope: source.scope,
      sessionIndexEntries: context.sessionIndexEntries ?? this.#defaultSessionIndexEntries,
      stateSnapshot: context.stateSnapshot ?? this.#defaultStateSnapshot,
      revision: `sha256:${candidate.fingerprint.sha256}`,
    });
    const diagnostics = [...normalized.diagnostics, ...parseErrors(source.path, candidate.errors)];
    if (normalized.session === null) {
      replaceSourceFailureDiagnostics(this.#database, source.path, diagnostics);
      return {
        status: "failed",
        retainedSessionId: getSourceManifestEntry(this.#database, source.path)?.sessionId ?? null,
        diagnostics,
      };
    }
    if (
      context.expectedCatalogSessionId !== undefined &&
      normalized.session.summary.id !== context.expectedCatalogSessionId
    ) {
      const mismatchDiagnostics = [
        cacheFailure(
          source.path,
          new Error(
            `Expected session ${context.expectedCatalogSessionId}, received ${normalized.session.summary.id}.`,
          ),
        ),
      ];
      replaceSourceFailureDiagnostics(this.#database, source.path, mismatchDiagnostics);
      return {
        status: "failed",
        retainedSessionId: getSourceManifestEntry(this.#database, source.path)?.sessionId ?? null,
        diagnostics: mismatchDiagnostics,
      };
    }
    normalized.session.summary.diagnosticCount = diagnostics.length;
    const replacement = replaceCachedSession(this.#database, {
      session: normalized.session,
      diagnostics,
      source: {
        fingerprint: candidate.fingerprint,
        scope: source.scope,
        identity: candidate.identity,
      },
      expectedCatalogSourceRevision: context.expectedCatalogSourceRevision,
    });
    if (replacement.status === "stale-catalog") {
      return {
        status: "stale-catalog",
        sessionId: normalized.session.summary.id,
        fingerprint: candidate.fingerprint,
        retainedSessionId: normalized.session.summary.id,
        diagnostics: [],
      };
    }
    clearSourceFailureDiagnostics(this.#database, source.path);
    if (this.#retainLiveSources) {
      this.#liveSources.set(source.path, candidate);
    } else {
      this.#liveSources.delete(source.path);
    }
    return {
      status: "updated",
      mode,
      sessionId: normalized.session.summary.id,
      fingerprint: candidate.fingerprint,
      diagnostics,
    };
  }

  async update(
    source: DiscoveredRolloutSource,
    context: SessionCacheUpdateContext = {},
  ): Promise<SessionCacheUpdateResult> {
    const persisted = getSourceManifestEntry(this.#database, source.path);
    try {
      const observed = await observeSource(source.path);
      const live = this.#liveSources.get(source.path);
      if (
        !context.force &&
        persisted !== null &&
        matchesFingerprint(persisted, observed, this.#parserVersion)
      ) {
        return {
          status: "unchanged",
          sessionId: persisted.sessionId,
          fingerprint: persisted.fingerprint,
        };
      }
      if (!context.force && persisted !== null) {
        const fingerprint = await verifyTouchedSource(persisted, observed, this.#parserVersion);
        if (fingerprint !== null) {
          storeTouchedSourceFingerprint(this.#database, persisted, fingerprint);
          clearSourceFailureDiagnostics(this.#database, source.path);
          return {
            status: "unchanged",
            sessionId: persisted.sessionId,
            fingerprint,
          };
        }
      }
      if (
        context.force &&
        live !== undefined &&
        live.fingerprint.size === observed.size &&
        live.fingerprint.mtimeMs === observed.mtimeMs &&
        sameIdentity(live.identity, observed.identity)
      ) {
        return this.#normalizeAndStore(source, live, "memory", context);
      }
      const canAppend =
        live !== undefined &&
        live.fingerprint.parserVersion === this.#parserVersion &&
        observed.size > live.fingerprint.size &&
        sameIdentity(live.identity, observed.identity);
      const candidate = canAppend
        ? await this.#readAppend(source, live)
        : await this.#readFull(source);
      if (candidate === null) {
        const diagnostics = [changedDuringRead(source.path)];
        replaceSourceFailureDiagnostics(this.#database, source.path, diagnostics);
        return {
          status: "failed",
          retainedSessionId: persisted?.sessionId ?? null,
          diagnostics,
        };
      }
      return this.#normalizeAndStore(source, candidate, candidate.mode, context);
    } catch (error) {
      const diagnostics = [cacheFailure(source.path, error)];
      replaceSourceFailureDiagnostics(this.#database, source.path, diagnostics);
      return {
        status: "failed",
        retainedSessionId: persisted?.sessionId ?? null,
        diagnostics,
      };
    }
  }
}
