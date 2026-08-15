import type {
  ConversationActivity,
  ConversationTurn,
  JsonValue,
} from "#shared/types/conversation.ts";
import type { PresentationSettings } from "#shared/types/settings.ts";

export function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) {
    return null;
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)} ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatTimestamp(
  timestamp: string | null,
  mode: PresentationSettings["timestampFormat"],
): string {
  if (timestamp === null) {
    return "Time unavailable";
  }
  const date = new Date(timestamp);
  const absolute = date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  if (mode === "absolute") {
    return absolute;
  }
  const elapsedSeconds = Math.round((date.getTime() - Date.now()) / 1_000);
  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (Math.abs(elapsedSeconds) < 60) {
    value = elapsedSeconds;
    unit = "second";
  } else if (Math.abs(elapsedSeconds) < 3_600) {
    value = Math.round(elapsedSeconds / 60);
    unit = "minute";
  } else if (Math.abs(elapsedSeconds) < 86_400) {
    value = Math.round(elapsedSeconds / 3_600);
    unit = "hour";
  } else {
    value = Math.round(elapsedSeconds / 86_400);
    unit = "day";
  }
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
  return mode === "relative" ? relative : `${relative} · ${absolute}`;
}

export function formattedJson(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function activityText(activity: ConversationActivity): string | null {
  if (activity.kind === "reasoning") {
    return activity.summary.trim() === "" ? null : `Reasoning\n${activity.summary}`;
  }
  if (activity.kind === "tool") {
    const label = `${activity.namespace === null ? "tool" : activity.namespace}/${activity.name}`;
    return [
      `${label} · ${activity.status}`,
      `Input\n${formattedJson(activity.input)}`,
      `Output\n${formattedJson(activity.output)}`,
      activity.error === null ? null : `Error\n${activity.error}`,
    ]
      .filter((value): value is string => value !== null)
      .join("\n");
  }
  if (activity.kind === "web_search") {
    return `Web search · ${activity.status}\n${activity.query}`;
  }
  if (activity.kind === "patch") {
    return `Patch · ${activity.status}\n${activity.patch}`;
  }
  if (activity.kind === "plan") {
    return `Plan${activity.title === null ? "" : ` · ${activity.title}`}\n${activity.items.map(({ status, step }) => `[${status}] ${step}`).join("\n")}`;
  }
  if (activity.kind === "subagent") {
    return `Agent · ${activity.status}\n${activity.description}`;
  }
  if (activity.kind === "status") {
    return `Status · ${activity.status}\n${activity.message}`;
  }
  if (activity.kind === "compaction") {
    return activity.summary === null
      ? "Conversation compacted"
      : `Conversation compacted\n${activity.summary}`;
  }
  if (activity.kind === "media") {
    return `Media · ${activity.mediaType}\n${activity.sourcePath ?? activity.assetId}`;
  }
  return null;
}

export function agentWorkText(turn: ConversationTurn): string {
  return [
    ...turn.activities.map(activityText),
    ...turn.assistantMessages.map(({ sourceMarkdown }) => sourceMarkdown),
  ]
    .filter((value): value is string => value !== null && value.trim() !== "")
    .join("\n\n");
}
