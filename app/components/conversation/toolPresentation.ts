import type {
  ActivityStatus,
  ConversationActivity,
  JsonObject,
  JsonValue,
  ToolActivity,
  SubagentActivity,
} from "#shared/types/conversation.ts";
import type { RichTextDocument, RichTextNode } from "#shared/types/richText.ts";

export type ToolCategory = "shell" | "read" | "search" | "edit" | "web" | "app" | "agent" | "other";
export interface ToolPresentation {
  category: ToolCategory;
  label: string;
  subject: string;
  rawName: string;
  childId: string | null;
}
export function objectValue(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
export function textField(value: JsonValue | undefined, ...keys: string[]): string | null {
  const object = objectValue(value);
  for (const key of keys) {
    if (typeof object?.[key] === "string" && object[key] !== "") {
      return object[key];
    }
  }
  return null;
}
export function statusLabel(status: ActivityStatus): string {
  return {
    succeeded: "Success",
    failed: "Failed",
    cancelled: "Cancelled",
    running: "Running",
    pending: "Pending",
    unknown: "Unknown",
  }[status];
}
export function shortText(value: string, limit = 180): string {
  const text = value
    .slice(0, limit + 1)
    .replace(/\s+/gu, " ")
    .trim();
  return value.length > limit ? `${text.slice(0, limit)}…` : text;
}
export function toolPresentation(activity: ToolActivity): ToolPresentation {
  const rawName =
    activity.namespace === null ? activity.name : `${activity.namespace}/${activity.name}`;
  const parts = activity.name.split(/[/.]/u);
  const name = parts.at(-1)!;
  const namespace = activity.namespace ?? (parts.length > 1 ? parts.slice(0, -1).join(".") : null);
  const core =
    namespace === null ||
    ["functions", "tools", "filesystem", "agents", "multi_tool_use"].includes(namespace);
  const input = activity.input;
  const success = activity.status === "succeeded";
  let category: ToolCategory = "other";
  let label = name.replaceAll("_", " ");
  let subject = textField(input, "description", "path", "query", "url") ?? "";
  let childId: string | null = null;
  if (core && ["exec_command", "shell_command", "shell", "write_stdin"].includes(name)) {
    category = "shell";
    label =
      name === "write_stdin" ? "Command input/output" : success ? "Ran command" : "Run command";
    subject = textField(input, "cmd", "command", "chars") ?? "Shell";
    // Only classify a single literal command; compound shell syntax remains a command.
    if (name !== "write_stdin" && !/[\n\r;&|`$<>]/u.test(subject)) {
      const executable = /^\s*([\w-]+)(?:\s|$)/u.exec(subject)?.[1]?.toLowerCase();
      if (["get-content", "cat"].includes(executable ?? "")) {
        category = "read";
        label = "Read file";
      } else if (
        ["get-childitem", "ls", "dir"].includes(executable ?? "") ||
        (executable === "rg" && /^\s*rg\s+--files(?:\s|$)/u.test(subject))
      ) {
        category = "read";
        label = success ? "Listed files" : "List files";
      } else if (["rg", "grep", "findstr"].includes(executable ?? "")) {
        category = "search";
        label = success ? "Searched files" : "Search files";
      }
    }
  } else if (namespace === "functions" && name === "exec") {
    category = "shell";
    label = "Tool script";
    subject = "Recorded tool orchestration";
  } else if (core && ["read_file", "read", "list_directory", "list_files"].includes(name)) {
    category = "read";
    label = name.startsWith("list") ? (success ? "Listed files" : "List files") : "Read file";
    subject =
      textField(input, "path", "file_path", "directory") ??
      (typeof input === "string" ? input : "Files");
  } else if (core && ["search", "search_files", "grep", "find_files"].includes(name)) {
    category = "search";
    label = success ? "Searched files" : "Search files";
    subject = textField(input, "query", "pattern", "path") ?? "Files";
  } else if (core && ["apply_patch", "edit_file", "write_file"].includes(name)) {
    category = "edit";
    label = "File edit";
    subject = textField(input, "path", "file_path") ?? "Recorded patch";
  } else if (
    (namespace === "web" && ["run", "search", "open"].includes(name)) ||
    (core && name === "web_search")
  ) {
    category = "web";
    const request = objectValue(input);
    const searches = request?.["search_query"];
    const opens = request?.["open"];
    const firstSearch = Array.isArray(searches) ? searches[0] : undefined;
    const firstOpen = Array.isArray(opens) ? opens[0] : undefined;
    label =
      firstOpen !== undefined || name === "open"
        ? success
          ? "Opened web page"
          : "Open web page"
        : success
          ? "Searched the web"
          : "Search the web";
    subject =
      textField(firstSearch, "q") ??
      textField(firstOpen, "ref_id") ??
      textField(input, "query", "q", "url") ??
      "Web request";
  } else if (
    core &&
    [
      "spawn_agent",
      "send_message",
      "send_input",
      "followup_task",
      "resume_agent",
      "wait_agent",
      "wait",
      "close_agent",
      "interrupt_agent",
      "list_agents",
    ].includes(name)
  ) {
    category = "agent";
    label = (
      {
        spawn_agent: "Started subagent",
        send_message: "Sent message to",
        send_input: "Sent message to",
        followup_task: "Resumed subagent",
        resume_agent: "Resumed subagent",
        wait_agent: "Waited for subagents",
        wait: "Waited for subagents",
        close_agent: "Closed subagent",
        interrupt_agent: "Interrupted subagent",
        list_agents: "Listed subagents",
      } as Record<string, string>
    )[name]!;
    if (!success) {
      label = label
        .replace(/^Started/u, "Start")
        .replace(/^Sent/u, "Send message to")
        .replace("Send message to message to", "Send message to")
        .replace(/^Resumed/u, "Resume")
        .replace(/^Closed/u, "Close")
        .replace(/^Interrupted/u, "Interrupt")
        .replace(/^Waited/u, "Wait")
        .replace(/^Listed/u, "List");
    }
    childId =
      textField(activity.output, "thread_id", "threadId", "agent_id", "agentId") ??
      textField(input, "thread_id", "threadId", "agent_id", "agentId", "id");
    subject =
      textField(input, "task_name", "target", "agent_name", "nickname") ??
      textField(activity.output, "agent_name", "nickname", "name") ??
      childId ??
      "Recorded child activity";
  } else if (activity.name.startsWith("mcp__") || namespace?.startsWith("mcp") === true) {
    category = "app";
    const segments = activity.name.split("__");
    const operation = segments.at(-1)!;
    const app =
      segments.length > 2 ? segments[1]! : (namespace?.replace(/^mcp[_/]*/u, "") ?? "App");
    label = `${app.replaceAll("_", " ")} · ${operation.replaceAll("_", " ")}`;
    subject =
      textField(input, "query", "title", "name", "url", "path", "description") ??
      "Recorded app operation";
  }
  return { category, label, subject: shortText(subject), rawName, childId };
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
  const content = output?.["content"];
  if (
    Array.isArray(content) &&
    content.some((item) => ["image", "audio", "resource"].includes(textField(item, "type") ?? ""))
  ) {
    return "Media result recorded. Cached media is shown in the conversation when available; preserved payload is in Technical details.";
  }
  if (Array.isArray(content) && content.length === 1) {
    const text = textField(content[0], "text");
    if (text !== null) {
      return text;
    }
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
