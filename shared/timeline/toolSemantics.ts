import type { ActivityStatus, JsonObject, JsonValue, ToolActivity } from "../types/conversation.ts";

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
  if (activity.presentation && activity.presentation.category !== "other") {
    return {
      category: activity.presentation.category,
      label: activity.presentation.label,
      subject: shortText(activity.presentation.subject),
      rawName,
      childId:
        activity.presentation.childIds.length === 1 ? activity.presentation.childIds[0]! : null,
    };
  }
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
  } else if (namespace === "functions" && (name === "exec" || name === "wait")) {
    category = "shell";
    label = name === "wait" ? "Tool script continuation" : "Tool script";
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
  if (activity.presentation?.evidenceKind === "host-attempt") {
    label = `Attempted: ${label}`;
  }
  return { category, label, subject: shortText(subject), rawName, childId };
}

/** Shared semantic identity used by normalized activities and the established renderer */
export function presentTool(activity: ToolActivity): ToolActivity {
  const display = toolPresentation(activity);
  return {
    ...activity,
    presentation: {
      category: display.category,
      label: display.label,
      subject: display.subject,
      status: activity.status,
      evidenceKind: activity.presentation?.evidenceKind ?? "direct",
      itemId: activity.nativeItemId ?? activity.presentation?.itemId ?? null,
      callId: activity.callId,
      cellId: activity.codeMode?.cellId ?? activity.presentation?.cellId ?? null,
      childIds: activity.presentation?.childIds ?? (display.childId ? [display.childId] : []),
      details: activity.presentation?.details ?? { sourceEventIds: activity.rawEventIds },
    },
  };
}
