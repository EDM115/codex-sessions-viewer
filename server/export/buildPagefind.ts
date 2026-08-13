import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";

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

export async function buildPagefind(
  conversations: readonly NormalizedSession[],
  outputPath: string,
  options: PagefindBuildOptions = {},
): Promise<PagefindBuildResult> {
  const outputParent = dirname(outputPath);
  await ensureSafeOutputDirectory(outputParent);
  const stagingPath = join(outputParent, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  await ensureSafeOutputDirectory(stagingPath);
  const records = createPagefindTurnRecords(conversations);
  try {
    const created = await pagefind.createIndex({ forceLanguage: "en", writePlayground: false });
    if (created.index === undefined || created.errors.length > 0) {
      await pagefind.close();
      throw new Error(`Pagefind could not create an index: ${created.errors.join("; ")}`);
    }
    const index = created.index;
    try {
      for (const [recordIndex, record] of records.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- Pagefind owns an ordered native service and reports errors per record.
        const added = await index.addCustomRecord(record);
        if (added.errors.length > 0) {
          throw new Error(`Pagefind could not index ${record.url}: ${added.errors.join("; ")}`);
        }
        options.onRecordProgress?.(recordIndex + 1, records.length);
      }
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
    return { recordCount: records.length, outputPath };
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}
