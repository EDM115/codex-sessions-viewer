import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as z from "zod";

import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import { stableRead } from "../ingestion/stableRead.ts";

const booleanIntegerSchema = z
  .union([z.literal(0), z.literal(1)])
  .transform((value) => value === 1);

const threadRowSchema = z.strictObject({
  id: z.string(),
  rolloutPath: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  source: z.string(),
  modelProvider: z.string(),
  cwd: z.string(),
  title: z.string(),
  tokensUsed: z.number(),
  archived: booleanIntegerSchema,
  archivedAt: z.number().nullable(),
  gitSha: z.string().nullable(),
  gitBranch: z.string().nullable(),
  gitOriginUrl: z.string().nullable(),
  firstUserMessage: z.string(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  name: z.string().nullable(),
  pinned: booleanIntegerSchema,
  sectionId: z.string().nullable(),
});

const sectionRowSchema = z.strictObject({ id: z.string(), name: z.string() });
const spawnEdgeRowSchema = z.strictObject({
  parentThreadId: z.string(),
  childThreadId: z.string(),
  status: z.string(),
});
const quickCheckSchema = z.array(z.strictObject({ quick_check: z.literal("ok") })).length(1);
const currentSnapshotSchema = z.strictObject({ generationPath: z.string().min(1) });

export type StateThreadMetadata = z.output<typeof threadRowSchema>;
export type StateSectionMetadata = z.output<typeof sectionRowSchema>;
export type StateSpawnEdgeMetadata = z.output<typeof spawnEdgeRowSchema>;

export interface StateMetadataSnapshot {
  threads: StateThreadMetadata[];
  sections: StateSectionMetadata[];
  spawnEdges: StateSpawnEdgeMetadata[];
}

export interface StateSnapshotOptions {
  sourceDatabase: string;
  sourceWal: string;
  snapshotRoot: string;
}

export interface StateSnapshotResult {
  status: "created" | "retained" | "unavailable";
  generationPath: string | null;
  metadata: StateMetadataSnapshot | null;
  diagnostics: ViewerDiagnostic[];
}

interface ObservedFile {
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface ObservedStateSources {
  database: ObservedFile;
  wal: ObservedFile | null;
}

function observe(stats: BigIntStats): ObservedFile {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFile(left: ObservedFile, right: ObservedFile): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameOptionalFile(left: ObservedFile | null, right: ObservedFile | null): boolean {
  return left === null || right === null ? left === right : sameFile(left, right);
}

function sameSources(left: ObservedStateSources, right: ObservedStateSources): boolean {
  return sameFile(left.database, right.database) && sameOptionalFile(left.wal, right.wal);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function observeRegularFile(path: string, optional = false): Promise<ObservedFile | null> {
  try {
    const pathStats = await lstat(path, { bigint: true });
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      throw new Error(`Expected a regular source file: ${path}`);
    }
    return observe(pathStats);
  } catch (error) {
    if (optional && isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function observeSources(options: StateSnapshotOptions): Promise<ObservedStateSources> {
  const [database, wal] = await Promise.all([
    observeRegularFile(options.sourceDatabase),
    observeRegularFile(options.sourceWal, true),
  ]);
  if (database === null) {
    throw new Error("The source state database is unavailable");
  }
  return { database, wal };
}

async function copyStableFile(source: string, destination: string): Promise<void> {
  const destinationHandle = await open(destination, "wx", 0o600);
  try {
    const result = await stableRead(source, {
      async onChunk({ bytes }) {
        await destinationHandle.writeFile(bytes);
      },
    });
    if (result.status !== "stable") {
      throw new Error("Source changed while it was copied");
    }
  } finally {
    await destinationHandle.close();
  }
}

function querySnapshot(generationPath: string): StateMetadataSnapshot {
  const database = new DatabaseSync(join(generationPath, "state_5.sqlite"), {
    readOnly: true,
    allowExtension: false,
  });
  try {
    database.enableDefensive(true);
    database.exec("PRAGMA query_only = ON");
    quickCheckSchema.parse(database.prepare("PRAGMA quick_check").all());
    const threads = threadRowSchema.array().parse(
      database
        .prepare(`
          SELECT
            id,
            rollout_path AS rolloutPath,
            created_at AS createdAt,
            updated_at AS updatedAt,
            source,
            model_provider AS modelProvider,
            cwd,
            title,
            tokens_used AS tokensUsed,
            archived,
            archived_at AS archivedAt,
            git_sha AS gitSha,
            git_branch AS gitBranch,
            git_origin_url AS gitOriginUrl,
            first_user_message AS firstUserMessage,
            model,
            reasoning_effort AS reasoningEffort,
            name,
            is_pinned AS pinned,
            thread_section_id AS sectionId
          FROM threads
          ORDER BY id
        `)
        .all(),
    );
    const sections = sectionRowSchema
      .array()
      .parse(database.prepare("SELECT id, name FROM thread_sections ORDER BY id").all());
    const spawnEdges = spawnEdgeRowSchema.array().parse(
      database
        .prepare(`
          SELECT
            parent_thread_id AS parentThreadId,
            child_thread_id AS childThreadId,
            status
          FROM thread_spawn_edges
          ORDER BY child_thread_id
        `)
        .all(),
    );
    return { threads, sections, spawnEdges };
  } finally {
    database.close();
  }
}

function snapshotDiagnostic(path: string, error: unknown): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "metadata.snapshot_invalid",
    severity: "warning",
    area: "metadata",
    message:
      "A validated Codex state snapshot could not be obtained; rollout files remain available.",
    path,
    details: { reason: error instanceof Error ? error.message : "Unknown snapshot error" },
  });
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function retainCurrentSnapshot(
  snapshotRoot: string,
  diagnostic: ViewerDiagnostic,
): Promise<StateSnapshotResult> {
  try {
    const current = currentSnapshotSchema.parse(
      JSON.parse(await readFile(join(snapshotRoot, "current.json"), "utf8")),
    );
    const generationsRoot = join(snapshotRoot, "generations");
    if (!isWithinRoot(generationsRoot, current.generationPath)) {
      throw new Error("Current snapshot points outside the viewer-owned generation directory");
    }
    const metadata = querySnapshot(current.generationPath);
    return {
      status: "retained",
      generationPath: current.generationPath,
      metadata,
      diagnostics: [diagnostic],
    };
  } catch {
    return {
      status: "unavailable",
      generationPath: null,
      metadata: null,
      diagnostics: [diagnostic],
    };
  }
}

export async function readRetainedStateSnapshot(
  snapshotRoot: string,
): Promise<StateSnapshotResult> {
  const diagnostic = createViewerDiagnostic({
    code: "metadata.snapshot_invalid",
    severity: "warning",
    area: "metadata",
    message: "No validated retained Codex state snapshot is currently available.",
    path: join(snapshotRoot, "current.json"),
  });
  const retained = await retainCurrentSnapshot(snapshotRoot, diagnostic);
  return retained.status === "retained" ? { ...retained, diagnostics: [] } : retained;
}

export async function snapshotStateDatabase(
  options: StateSnapshotOptions,
): Promise<StateSnapshotResult> {
  const generationsRoot = join(options.snapshotRoot, "generations");
  const generationId = randomUUID();
  const temporaryGeneration = join(generationsRoot, `.${generationId}.tmp`);
  const generationPath = join(generationsRoot, generationId);

  try {
    const before = await observeSources(options);
    await mkdir(temporaryGeneration, { recursive: true, mode: 0o700 });
    await copyStableFile(options.sourceDatabase, join(temporaryGeneration, "state_5.sqlite"));
    if (before.wal !== null) {
      await copyStableFile(options.sourceWal, join(temporaryGeneration, "state_5.sqlite-wal"));
    }
    const after = await observeSources(options);
    if (!sameSources(before, after)) {
      throw new Error("Codex state changed while snapshot bytes were copied");
    }

    const metadata = querySnapshot(temporaryGeneration);
    await rename(temporaryGeneration, generationPath);
    const temporaryManifest = join(options.snapshotRoot, `.current-${generationId}.tmp`);
    await writeFile(temporaryManifest, `${JSON.stringify({ generationPath })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryManifest, join(options.snapshotRoot, "current.json"));
    return { status: "created", generationPath, metadata, diagnostics: [] };
  } catch (error) {
    await rm(temporaryGeneration, { recursive: true, force: true });
    return retainCurrentSnapshot(
      options.snapshotRoot,
      snapshotDiagnostic(options.sourceDatabase, error),
    );
  }
}
