import * as z from "zod";

import {
  conversationScopeSchema,
  conversationSummarySchema,
  isoTimestampSchema,
  type ConversationSummary,
} from "./conversation.ts";

export type MaterializationState = "cold" | "queued" | "loading" | "ready" | "failed";

export interface ConversationListItem {
  summary: ConversationSummary;
  kind: "root" | "subagent";
  materialization: MaterializationState;
  projectId: string;
  parentThreadId: string | null;
  agentPath: string | null;
  agentNickname: string | null;
  agentDepth: number | null;
  childCount: number;
}

export interface ConversationProject {
  id: string;
  name: string;
  source: "codex" | "git" | "cwd" | "none";
  hint: string | null;
  activeCount: number;
  archivedCount: number;
}

export interface PreparationResult {
  id: string;
  state: MaterializationState;
  error: string | null;
}

export type DeepSearchState = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface DeepSearchJob {
  id: string;
  scope: "active" | "archived";
  query: string;
  state: DeepSearchState;
  total: number;
  completed: number;
  failed: number;
  resultCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const materializationStateSchema = z.enum(["cold", "queued", "loading", "ready", "failed"]);

export const conversationListItemSchema = z.strictObject({
  summary: conversationSummarySchema,
  kind: z.enum(["root", "subagent"]),
  materialization: materializationStateSchema,
  projectId: z.string().min(1),
  parentThreadId: z.string().min(1).nullable(),
  agentPath: z.string().min(1).nullable(),
  agentNickname: z.string().min(1).nullable(),
  agentDepth: z.int().nonnegative().nullable(),
  childCount: z.int().nonnegative(),
});

export const conversationProjectSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(["codex", "git", "cwd", "none"]),
  hint: z.string().min(1).nullable(),
  activeCount: z.int().nonnegative(),
  archivedCount: z.int().nonnegative(),
});

export const conversationProjectsSchema = z.array(conversationProjectSchema);

export const preparationResultSchema = z.strictObject({
  id: z.string().min(1),
  state: materializationStateSchema,
  error: z.string().nullable(),
});

export const preparationResultsSchema = z.array(preparationResultSchema);

export const deepSearchJobSchema = z.strictObject({
  id: z.string().min(1),
  scope: conversationScopeSchema,
  query: z.string().min(1),
  state: z.enum(["queued", "running", "completed", "cancelled", "failed"]),
  total: z.int().nonnegative(),
  completed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  resultCount: z.int().nonnegative(),
  error: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
