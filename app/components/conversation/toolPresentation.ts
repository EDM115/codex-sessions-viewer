import {
  toolPresentation,
  objectValue,
  textField,
  shortText,
  type ToolCategory,
} from "#shared/timeline/toolSemantics.ts";
import type {
  ConversationActivity,
  JsonObject,
  JsonValue,
  ToolActivity,
  SubagentActivity,
  ReasoningActivity,
  GuardianApprovalEvidence,
} from "#shared/types/conversation.ts";
import type { RichTextDocument, RichTextNode } from "#shared/types/richText.ts";
export {
  toolPresentation,
  objectValue,
  textField,
  shortText,
  statusLabel,
} from "#shared/timeline/toolSemantics.ts";
export type { ToolCategory, ToolPresentation } from "#shared/timeline/toolSemantics.ts";

export { finalAssistantId } from "#shared/timeline/finalAnswer.ts";

export function reasoningText(activity: ReasoningActivity): string {
  function text(nodes: RichTextNode[]): string {
    return nodes
      .map((node) =>
        node.type === "text" ? node.text : "children" in node ? text(node.children) : "",
      )
      .join("");
  }
  return activity.body === null ? "" : text(activity.body.children).trim();
}

export function hasReasoning(activity: ReasoningActivity): boolean {
  return (
    activity.summary.trim() !== "" ||
    reasoningText(activity) !== "" ||
    (activity.body !== null && bodyAssetIds(activity.body).size > 0)
  );
}

export function activityGroupingKey(activity: ConversationActivity): string | null {
  if (!("status" in activity) || activity.status !== "succeeded") {
    return null;
  }
  if (activity.kind === "tool") {
    const display = toolPresentation(activity);
    if (
      display.category === "agent" ||
      display.category === "other" ||
      activity.approval ||
      activity.approvalAttempts?.length ||
      activity.codeMode ||
      /computer|interactive|approval|request_user_input|imagegen|cua|browser|playwright/iu.test(
        `${activity.namespace}/${activity.name}`,
      ) ||
      activity.presentation?.evidenceKind === "host-attempt"
    ) {
      return null;
    }
    const context =
      textField(activity.input, "cwd", "workdir", "directory", "project", "host") ?? "";
    return JSON.stringify([
      display.category,
      display.rawName,
      context,
      activity.presentation?.cellId ?? null,
    ]);
  }
  if (activity.kind === "file_change") {
    return JSON.stringify([
      activity.kind,
      [...new Set(activity.files.map((file) => file.change))].toSorted(),
    ]);
  }
  return activity.kind === "patch" || activity.kind === "web_search" ? activity.kind : null;
}

export function activateChild(event: MouseEvent, id: string, open: (id: string) => void): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  open(id);
}

export function approvalLabel(attempt: GuardianApprovalEvidence): string {
  if (attempt.outcome === "allow") {
    return "Approved";
  }
  if (attempt.outcome === "deny") {
    return "Denied";
  }
  if (/timed.?out|timeout/iu.test(attempt.status ?? "")) {
    return "Timed out";
  }
  if (/abort|cancel/iu.test(attempt.status ?? "")) {
    return "Aborted";
  }
  return attempt.status ? `Review ${attempt.status}` : "Review outcome unavailable";
}

export function activityCategory(activity: ConversationActivity): ToolCategory | null {
  if (activity.kind === "tool") {
    return toolPresentation(activity).category;
  }
  if (activity.kind === "file_change" || activity.kind === "patch") {
    return "edit";
  }
  if (activity.kind === "web_search") {
    return "web";
  }
  return null;
}
export function groupLabel(activities: ConversationActivity[]): string {
  const counts = new Map<ToolCategory, number>();
  for (const activity of activities) {
    const category = activityCategory(activity);
    if (category !== null) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(
      ([category, count]) =>
        ({
          shell: count === 1 ? "ran a command" : "ran commands",
          read: "read files",
          search: "searched files",
          edit: "edited files",
          web: "searched the web",
          app: "used apps",
          agent: "subagent activity",
          other: "used tools",
        })[category],
    )
    .join(", ")
    .replace(/^./u, (letter) => letter.toUpperCase());
}
export function bodyAssetIds(document: RichTextDocument): Set<string> {
  const ids = new Set<string>();
  function visit(nodes: RichTextNode[]): void {
    for (const node of nodes) {
      if (node.type === "media" && node.assetId !== null) {
        ids.add(node.assetId);
      }
      if ("children" in node) {
        visit(node.children);
      }
    }
  }
  visit(document.children);
  return ids;
}
export function boundedJson(value: JsonValue, limit = 16_000): { text: string; partial: boolean } {
  let remaining = limit;
  let partial = false;
  function bounded(current: JsonValue, depth: number): JsonValue {
    if (remaining <= 0 || depth > 12) {
      partial = true;
      return "…";
    }
    if (typeof current === "string") {
      const allowed = Math.max(0, remaining);
      remaining -= current.length;
      if (current.length > allowed) {
        partial = true;
        return `${current.slice(0, allowed)}…`;
      }
      return current;
    }
    if (current === null || typeof current !== "object") {
      remaining -= 8;
      return current;
    }
    if (Array.isArray(current)) {
      const result: JsonValue[] = [];
      for (const item of current) {
        if (remaining <= 0 || result.length >= 100) {
          partial = true;
          break;
        }
        result.push(bounded(item, depth + 1));
      }
      return result;
    }
    const result: JsonObject = {};
    let count = 0;
    for (const key in current) {
      if (!Object.hasOwn(current, key)) {
        continue;
      }
      if (remaining <= 0 || count++ >= 100) {
        partial = true;
        break;
      }
      remaining -= key.length;
      result[key] = bounded(current[key]!, depth + 1);
    }
    return result;
  }
  const result = bounded(value, 0);
  return { text: typeof result === "string" ? result : JSON.stringify(result, null, 2), partial };
}
export function toolOutput(activity: ToolActivity): JsonValue {
  if (typeof activity.output === "string") {
    return activity.output;
  }
  const output = objectValue(activity.output);
  for (const key of ["output", "stdout", "text", "message", "content"]) {
    if (typeof output?.[key] === "string") {
      return output[key];
    }
  }
  const content = Array.isArray(activity.output) ? activity.output : output?.["content"];
  if (
    Array.isArray(content) &&
    content.some((item) =>
      [
        "image",
        "audio",
        "resource",
        "inputImage",
        "inputAudio",
        "input_image",
        "input_audio",
      ].includes(textField(item, "type") ?? ""),
    )
  ) {
    const texts = content.flatMap((item) => {
      const type = textField(item, "type");
      const text = textField(item, "text");
      return text !== null && ["text", "inputText", "input_text"].includes(type ?? "")
        ? [text]
        : [];
    });
    return [
      ...texts,
      "Media result recorded. Cached media is shown in the conversation when available (preserved payload is in Technical details).",
    ].join("\n");
  }
  if (
    Array.isArray(content) &&
    content.every((item) =>
      ["text", "inputText", "input_text"].includes(textField(item, "type") ?? ""),
    )
  ) {
    return content.map((item) => textField(item, "text") ?? "").join("\n");
  }
  return activity.output;
}

export function subagentLabel(activity: SubagentActivity): string {
  const parts = activity.description.split(" · ");
  const recorded = parts.at(-1)!;
  const verbs: Record<string, string> = {
    started: "Started",
    spawned: "Started",
    resumed: "Resumed",
    completed: "Finished",
    complete: "Finished",
    finished: "Finished",
    failed: "Failed",
    interrupted: "Interrupted",
    cancelled: "Cancelled",
    message_sent: "Sent message to",
    message_received: "Message from",
  };
  const verb = verbs[recorded.toLowerCase()];
  if (verb === undefined) {
    return shortText(activity.description);
  }
  const name = parts.length > 1 ? parts.slice(0, -1).join(" · ") : (activity.agentId ?? "subagent");
  return `${verb} ${name}`;
}
