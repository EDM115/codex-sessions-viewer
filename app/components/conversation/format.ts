import type {
  ConversationActivity,
  ConversationTurn,
  JsonValue,
  MediaActivity,
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

export function mediaReferenceText(activity: MediaActivity): string {
  const { reference } = activity;
  if (reference.kind === "local-file") {
    return reference.path;
  }
  if (reference.kind === "remote") {
    return reference.url;
  }
  if (reference.kind === "data") {
    return `Embedded ${reference.mimeType}`;
  }
  if (reference.kind === "asset") {
    return `${reference.mimeType} · ${reference.sha256.slice(0, 12)}`;
  }
  if (reference.reason === "missing") {
    return activity.assetId;
  }
  return reference.preview || reference.reason;
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
    const label =
      activity.name === "exec_command"
        ? "Ran command"
        : `${activity.namespace === null ? "tool" : activity.namespace}/${activity.name}`;
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
  if (activity.kind === "file_change") {
    return activity.files
      .map((file) => {
        const verb =
          file.change === "add"
            ? "Created file"
            : file.change === "delete"
              ? "Deleted file"
              : file.change === "move"
                ? "Moved file"
                : "Edited file";
        return `${verb} · ${file.path} (+${file.addedLines} −${file.removedLines})`;
      })
      .join("\n");
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
    return `Media · ${activity.mediaType}\n${mediaReferenceText(activity)}`;
  }
  return null;
}

export function agentWorkText(turn: ConversationTurn): string {
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
    .flatMap((reference) => {
      if (reference.kind === "activity") {
        const text = activities.get(reference.id);
        return text === undefined ? [] : [activityText(text)];
      }
      if (reference.id === turn.userMessage?.id || reference.id === finalAssistantId) {
        return [];
      }
      const message = messages.get(reference.id);
      return message === undefined
        ? []
        : [
            `${message.role === "user" ? "You (steering)" : "Assistant (progress)"}\n${message.sourceMarkdown}`,
          ];
    })
    .filter((value): value is string => value !== null && value.trim() !== "")
    .join("\n\n");
}
