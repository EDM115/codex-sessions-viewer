import { pathToFileURL } from "node:url";

import type {
  ConversationActivity,
  ConversationMessage,
  ConversationTurn,
  MediaActivity,
  ToolActivity,
} from "../../shared/types/conversation.ts";
import type { RichTextCodeNode } from "../../shared/types/richText.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";

function joinSections(sections: Array<string | null>): string {
  return sections
    .filter((section): section is string => section !== null && section !== "")
    .join("\n\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function htmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fenced(source: string, language = ""): string {
  const longestRun = Math.max(0, ...[...source.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${source}${source.endsWith("\n") ? "" : "\n"}${fence}`;
}

function prettyJson(value: ToolActivity["input"]): string {
  return JSON.stringify(value, null, 2);
}

function duration(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  if (value < 1_000) {
    return `${value}ms`;
  }
  const seconds = value / 1_000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function localMediaLink(media: MediaActivity): string | null {
  if (media.sourcePath === null) {
    return null;
  }
  const label = `${media.mediaType[0]!.toUpperCase()}${media.mediaType.slice(1)}`;
  let url: string;
  try {
    url = media.sourcePath.startsWith("file:")
      ? new URL(media.sourcePath).href
      : pathToFileURL(media.sourcePath).href;
  } catch {
    url = media.sourcePath;
  }
  return `- [${label}: \`${media.sourcePath.replaceAll("`", "\\`")}\`](${url})`;
}

export function serializeUserPrompt(
  message: ConversationMessage,
  attachments: readonly MediaActivity[] = [],
): string {
  const references = attachments
    .map(localMediaLink)
    .filter((link): link is string => link !== null);
  return references.length === 0
    ? message.sourceMarkdown
    : `${message.sourceMarkdown}\n\n### Attachments\n\n${references.join("\n")}`;
}

export function serializeAssistantMessage(message: ConversationMessage): string {
  return message.sourceMarkdown;
}

export function serializeCodeBlock(codeNode: RichTextCodeNode): string {
  return codeNode.source;
}

export function serializeToolActivity(tool: ToolActivity): string {
  const qualifiedName = tool.namespace === null ? tool.name : `${tool.namespace}.${tool.name}`;
  const summaryParts = [qualifiedName, tool.status, duration(tool.durationMs)].filter(
    (part): part is string => part !== null,
  );
  const error = tool.error === null ? null : `#### Error\n\n${tool.error}`;
  return [
    "<details>",
    `<summary>${htmlText(summaryParts.join(" — "))}</summary>`,
    "",
    "#### Input",
    "",
    fenced(prettyJson(tool.input), "json"),
    "",
    "#### Output",
    "",
    fenced(prettyJson(tool.output), "json"),
    ...(error === null ? [] : ["", error]),
    "",
    "</details>",
  ].join("\n");
}

function serializeActivity(activity: ConversationActivity): string | null {
  switch (activity.kind) {
    case "reasoning":
      return activity.summary === "" ? null : `#### Reasoning\n\n${activity.summary}`;
    case "tool":
      return serializeToolActivity(activity);
    case "web_search":
      return `#### Web search — ${activity.status}\n\n${activity.query}`;
    case "patch":
      return joinSections([
        `#### Patch — ${activity.status}`,
        activity.affectedPaths.length === 0
          ? null
          : activity.affectedPaths.map((path) => `- \`${path.replaceAll("`", "\\`")}\``).join("\n"),
        activity.patch === "" ? null : fenced(activity.patch, "diff"),
      ]);
    case "plan":
      return joinSections([
        `#### Plan${activity.title === null ? "" : ` — ${activity.title}`}`,
        activity.items
          .map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.step}`)
          .join("\n"),
      ]);
    case "subagent":
      return `#### Subagent — ${activity.status}\n\n${activity.description}`;
    case "status":
      return `#### Status — ${activity.status}\n\n${activity.message}`;
    case "compaction":
      return activity.summary === null ? null : `#### Compaction\n\n${activity.summary}`;
    case "media":
      return localMediaLink(activity);
    case "unknown":
      return null;
    default:
      return null;
  }
}

interface AgentWorkItem {
  timestamp: string | null;
  order: number;
  markdown: string | null;
}

function compareWorkItems(left: AgentWorkItem, right: AgentWorkItem): number {
  if (left.timestamp === null && right.timestamp !== null) {
    return 1;
  }
  if (left.timestamp !== null && right.timestamp === null) {
    return -1;
  }
  const byTimestamp = (left.timestamp ?? "").localeCompare(right.timestamp ?? "");
  return byTimestamp === 0 ? left.order - right.order : byTimestamp;
}

export function serializeAgentWork(turn: ConversationTurn): string {
  const items: AgentWorkItem[] = [
    ...turn.activities.map((activity, order) => ({
      timestamp: activity.createdAt,
      order,
      markdown: serializeActivity(activity),
    })),
    ...turn.assistantMessages.map((message, index) => ({
      timestamp: message.createdAt,
      order: turn.activities.length + index,
      markdown: serializeAssistantMessage(message),
    })),
  ];
  return items
    .toSorted(compareWorkItems)
    .map((item) => item.markdown)
    .filter((markdown): markdown is string => markdown !== null && markdown !== "")
    .join("\n\n");
}

function conversationFrontmatter(conversation: NormalizedSession): string {
  const { summary } = conversation;
  return [
    "---",
    `id: ${summary.id}`,
    `title: ${yamlString(summary.title)}`,
    `scope: ${summary.scope}`,
    `createdAt: ${yamlString(summary.createdAt)}`,
    `updatedAt: ${yamlString(summary.updatedAt)}`,
    `cwd: ${summary.cwd === null ? "null" : yamlString(summary.cwd)}`,
    `models: [${summary.models.map(yamlString).join(", ")}]`,
    `reasoningEfforts: [${summary.reasoningEfforts.map(yamlString).join(", ")}]`,
    `turnCount: ${summary.turnCount}`,
    `toolCallCount: ${summary.toolCallCount}`,
    `revision: ${yamlString(summary.revision)}`,
    "---",
  ].join("\n");
}

export function serializeConversation(conversation: NormalizedSession): string {
  const turns = conversation.turns.map((turn) => {
    const attachments = turn.activities.filter(
      (activity): activity is MediaActivity => activity.kind === "media",
    );
    return joinSections([
      `## Turn ${turn.index + 1}`,
      turn.userMessage === null
        ? null
        : `### User prompt\n\n${serializeUserPrompt(turn.userMessage, attachments)}`,
      `### Agent work\n\n${serializeAgentWork(turn)}`,
    ]);
  });
  return `${conversationFrontmatter(conversation)}\n\n# ${conversation.summary.title}\n\n${turns.join("\n\n")}\n`;
}
