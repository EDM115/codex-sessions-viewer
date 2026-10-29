import type { ToolActivity } from "#shared/types/conversation.ts";

export type NestedExecActivity = ToolActivity;

/** Script text and printed output cannot establish child invocation identity or outcome */
export function deriveNestedExecActivities(outer: ToolActivity): NestedExecActivity[] {
  return [outer];
}
