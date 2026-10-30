import type { ActivityStatus, JsonObject, JsonValue } from "#shared/types/conversation.ts";

function object(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
export function recordedActivityStatus(value: JsonValue | undefined): ActivityStatus | null {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "completed":
    case "complete":
    case "ok":
    case "success":
    case "succeeded":
      return "succeeded";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "cancelled";
    case "in_progress":
    case "running":
      return "running";
    case "pending":
      return "pending";
    default:
      return null;
  }
}
function commandTool(name: string, namespace: string | null): boolean {
  const parts = name.split(/[/.]/u);
  const tool = parts.at(-1);
  const qualifier = namespace ?? (parts.length > 1 ? parts.slice(0, -1).join(".") : null);
  return (
    (qualifier === null || ["functions", "tools"].includes(qualifier)) &&
    ["exec_command", "write_stdin", "shell_command"].includes(tool ?? "")
  );
}
export interface RecordedToolOutcome {
  status: ActivityStatus;
  error: string | null;
}

/** A serialized body carries no success bit, only recognized outcome metadata can qualify it */
export function decodeToolOutcome(
  output: JsonValue,
  context: { name: string; namespace: string | null; explicitStatus?: JsonValue },
): RecordedToolOutcome {
  const result = object(output);
  const explicit = recordedActivityStatus(context.explicitStatus);
  let outcome: RecordedToolOutcome = { status: "unknown", error: null };
  if (result && Object.keys(result).length === 1 && Object.hasOwn(result, "Err")) {
    outcome = {
      status: "failed",
      error: text(result["Err"]) ?? text(object(result["Err"])?.["message"]),
    };
  } else if (result && Object.keys(result).length === 1 && Object.hasOwn(result, "Ok")) {
    const inner = decodeToolOutcome(result["Ok"] ?? null, {
      name: context.name,
      namespace: context.namespace,
    });
    outcome = { ...inner, status: inner.status === "unknown" ? "succeeded" : inner.status };
  } else if (result?.["isError"] === true) {
    outcome = {
      status: "failed",
      error: text(result["error"]) ?? text(result["message"]) ?? "Tool returned an error",
    };
  } else if (result?.["isError"] === false) {
    outcome = { status: "succeeded", error: null };
  } else if (result && commandTool(context.name, context.namespace)) {
    if (typeof result["exit_code"] === "number" && Number.isInteger(result["exit_code"])) {
      outcome = {
        status: result["exit_code"] === 0 ? "succeeded" : "failed",
        error: result["exit_code"] === 0 ? null : `Command exited with code ${result["exit_code"]}`,
      };
    } else if (
      (typeof result["session_id"] === "number" || typeof result["session_id"] === "string") &&
      result["exit_code"] == null
    ) {
      outcome = { status: "running", error: null };
    }
  }
  if (outcome.status === "failed" || outcome.status === "running") {
    return outcome;
  }
  return { ...outcome, status: explicit ?? outcome.status };
}
