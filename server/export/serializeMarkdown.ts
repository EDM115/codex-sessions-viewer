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
    case "file_change":
      return activity.files
        .map((file) =>
          joinSections([
            `#### ${file.change === "add" ? "Created" : file.change === "delete" ? "Deleted" : file.change === "move" ? "Moved" : "Edited"} file — ${file.path}`,
            `+${file.addedLines} −${file.removedLines}`,
            file.diff === null ? null : fenced(file.diff, "diff"),
          ]),
        )
        .join("\n\n");
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

export function serializeAgentWork(turn: ConversationTurn): string {
  const finalAssistantId =
    turn.finalAssistantMessageId ?? turn.assistantMessages.at(-1)?.id ?? null;
  const messages = new Map(
    [turn.userMessage, ...(turn.steeringMessages ?? []), ...turn.assistantMessages]
      .filter((message) => message !== null)
      .map((message) => [message.id, message]),
  );
  const activities = new Map(turn.activities.map((activity) => [activity.id, activity]));
  const order = turn.entryOrder ?? [
    ...(turn.userMessage === null ? [] : [{ kind: "message" as const, id: turn.userMessage.id }]),
    ...(turn.steeringMessages ?? []).map(({ id }) => ({ kind: "message" as const, id })),
    ...turn.activities.map(({ id }) => ({ kind: "activity" as const, id })),
    ...turn.assistantMessages.map(({ id }) => ({ kind: "message" as const, id })),
  ];
  return order
    .map((reference) => {
      if (reference.kind === "activity") {
        return serializeActivity(activities.get(reference.id)!);
      }
      if (reference.id === turn.userMessage?.id || reference.id === finalAssistantId) {
        return null;
      }
      const message = messages.get(reference.id);
      if (message === undefined) {
        return null;
      }
      return `#### ${message.role === "user" ? "You — steering" : "Assistant — progress"}\n\n${serializeAssistantMessage(message)}`;
    })
    .filter((markdown): markdown is string => markdown !== null && markdown !== "")
    .join("\n\n");
}

export function finalAssistantMessage(turn: ConversationTurn): ConversationMessage | null {
  return (
    turn.assistantMessages.find(({ id }) => id === turn.finalAssistantMessageId) ??
    turn.assistantMessages.at(-1) ??
    null
  );
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
    const work = serializeAgentWork(turn);
    const workDuration =
      turn.durationMs === null
        ? null
        : turn.durationMs < 60_000
          ? duration(turn.durationMs)
          : `${Math.floor(Math.round(turn.durationMs / 1_000) / 60)}m ${Math.round(turn.durationMs / 1_000) % 60}s`;
    return joinSections([
      `## Turn ${turn.index + 1}`,
      turn.userMessage === null
        ? null
        : `### User prompt\n\n${serializeUserPrompt(turn.userMessage, attachments)}`,
      work === ""
        ? null
        : `### ${workDuration === null ? "Worked" : `Worked for ${workDuration}`}\n\n${work}`,
      finalAssistantMessage(turn) === null
        ? null
        : `### Assistant response\n\n${serializeAssistantMessage(finalAssistantMessage(turn)!)}`,
    ]);
  });
  return `${conversationFrontmatter(conversation)}\n\n# ${conversation.summary.title}\n\n${turns.join("\n\n")}\n`;
}
