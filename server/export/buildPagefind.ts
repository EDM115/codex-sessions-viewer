import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";

import * as pagefind from "pagefind";
import type { CustomRecord } from "pagefind";

import type { ConversationTurn } from "../../shared/types/conversation.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";
import { serializeAgentWork, serializeUserPrompt } from "./serializeMarkdown.ts";

export interface PagefindBuildResult {
  recordCount: number;
  outputPath: string;
}

export interface PagefindBuildOptions {
  onRecordProgress?: ((completed: number, total: number) => void) | undefined;
  onWriteStart?: (() => void) | undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pagefind record metadata is not an object.");
  }
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error("Pagefind record metadata contains a non-string value.");
    }
    record[key] = item;
  }
  return record;
}

function filterRecord(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pagefind record filters are not an object.");
  }
  const record: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
      throw new Error("Pagefind record filters contain a non-string array.");
    }
    record[key] = item;
  }
  return record;
}

function parsedPagefindRecord(line: string): CustomRecord {
  const value = JSON.parse(line) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("content" in value) ||
    typeof value.content !== "string" ||
    !("language" in value) ||
    typeof value.language !== "string"
  ) {
    throw new Error("Pagefind record spool contains an invalid record.");
  }
  return {
    url: value.url,
    content: value.content,
    language: value.language,
    meta: "meta" in value ? stringRecord(value.meta) : undefined,
    filters: "filters" in value ? filterRecord(value.filters) : undefined,
    sort: "sort" in value ? stringRecord(value.sort) : undefined,
  };
}

async function* readPagefindRecordSpool(path: string): AsyncGenerator<CustomRecord> {
  const input = createReadStream(path);
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  for await (const chunk of input) {
    buffered += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      if (line !== "") {
        yield parsedPagefindRecord(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
      newlineIndex = buffered.indexOf("\n");
    }
  }
  buffered += decoder.end();
  if (buffered !== "") {
    yield parsedPagefindRecord(buffered);
  }
}

export async function appendPagefindRecords(
  path: string,
  records: readonly CustomRecord[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
    throw new Error(`Pagefind record spool is not an unlinked regular file: ${path}`);
  }
  await appendFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function turnDate(turn: ConversationTurn, fallback: string): string {
  return (turn.userMessage?.createdAt ?? turn.startedAt ?? fallback).slice(0, 10);
}

function hasMedia(turn: ConversationTurn): boolean {
  return turn.activities.some(({ kind }) => kind === "media");
}

function projectFromCwd(cwd: string | null): string | null {
  if (cwd === null) {
    return null;
  }
  return /^[a-z]:[\\/]/iu.test(cwd) || cwd.includes("\\")
    ? win32.basename(cwd)
    : posix.basename(cwd);
}

function turnContent(turn: ConversationTurn): string {
  const prompt =
    turn.userMessage === null
      ? ""
      : serializeUserPrompt(
          turn.userMessage,
          turn.activities.filter((activity) => activity.kind === "media"),
        );
  return [prompt, serializeAgentWork(turn)].filter(Boolean).join("\n\n");
}

export function createPagefindTurnRecords(
  conversations: readonly NormalizedSession[],
): CustomRecord[] {
  return conversations.flatMap((conversation) =>
    conversation.turns.map((turn) => {
      const date = turnDate(turn, conversation.summary.updatedAt);
      const filters: Record<string, string[]> = {
        scope: [conversation.summary.scope],
        model: turn.models,
        tool: Object.keys(turn.toolCounts).toSorted(),
        media: [String(hasMedia(turn))],
        date: [date],
      };
      if (conversation.summary.cwd !== null) {
        filters["cwd"] = [conversation.summary.cwd];
      }
      const project = projectFromCwd(conversation.summary.cwd);
      if (project !== null && project !== "") {
        filters["project"] = [project];
      }
      return {
        url: `/session/${encodeURIComponent(conversation.summary.id)}#turn-${encodeURIComponent(turn.id)}`,
        content: turnContent(turn),
        language: "en",
        meta: {
          title: `${conversation.summary.title} — Turn ${turn.index + 1}`,
          sessionId: conversation.summary.id,
          turnId: turn.id,
          date,
        },
        filters,
        sort: { date },
      };
    }),
  );
}

async function ensureSafeOutputDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Pagefind output is not an unlinked directory: ${path}`);
  }
}

async function replacePagefindDirectory(stagingPath: string, outputPath: string): Promise<void> {
  try {
    const metadata = await lstat(outputPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Existing Pagefind output is not an unlinked directory: ${outputPath}`);
    }
    await rm(outputPath, { recursive: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  await rename(stagingPath, outputPath);
}

async function buildPagefindRecordSource(
  records: Iterable<CustomRecord> | AsyncIterable<CustomRecord>,
  recordCount: number,
  outputPath: string,
  options: PagefindBuildOptions = {},
): Promise<PagefindBuildResult> {
  const outputParent = dirname(outputPath);
  await ensureSafeOutputDirectory(outputParent);
  const stagingPath = join(outputParent, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  await ensureSafeOutputDirectory(stagingPath);
  try {
    const created = await pagefind.createIndex({ forceLanguage: "en", writePlayground: false });
    if (created.index === undefined || created.errors.length > 0) {
      await pagefind.close();
      throw new Error(`Pagefind could not create an index: ${created.errors.join("; ")}`);
    }
    const index = created.index;
    try {
      let completed = 0;
      for await (const record of records) {
        // oxlint-disable-next-line no-await-in-loop -- Pagefind owns an ordered native service and reports errors per record.
        const added = await index.addCustomRecord(record);
        if (added.errors.length > 0) {
          throw new Error(`Pagefind could not index ${record.url}: ${added.errors.join("; ")}`);
        }
        completed += 1;
        options.onRecordProgress?.(completed, recordCount);
      }
      if (completed !== recordCount) {
        throw new Error(
          `Pagefind record spool expected ${recordCount} records but contained ${completed}.`,
        );
      }
      options.onWriteStart?.();
      const written = await index.writeFiles({ outputPath: stagingPath });
      if (written.errors.length > 0) {
        throw new Error(
          `Pagefind could not write its browser bundle: ${written.errors.join("; ")}`,
        );
      }
    } finally {
      await index.deleteIndex();
      await pagefind.close();
    }
    await replacePagefindDirectory(stagingPath, outputPath);
    return { recordCount, outputPath };
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

export async function buildPagefindRecords(
  records: readonly CustomRecord[],
  outputPath: string,
  options: PagefindBuildOptions = {},
): Promise<PagefindBuildResult> {
  return buildPagefindRecordSource(records, records.length, outputPath, options);
}

export async function buildPagefindRecordSpool(
  spoolPath: string,
  recordCount: number,
  outputPath: string,
  options: PagefindBuildOptions = {},
): Promise<PagefindBuildResult> {
  return buildPagefindRecordSource(
    readPagefindRecordSpool(spoolPath),
    recordCount,
    outputPath,
    options,
  );
}

export async function buildPagefind(
  conversations: readonly NormalizedSession[],
  outputPath: string,
  options: PagefindBuildOptions = {},
): Promise<PagefindBuildResult> {
  return buildPagefindRecords(createPagefindTurnRecords(conversations), outputPath, options);
}
