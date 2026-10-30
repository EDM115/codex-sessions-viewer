import type { ThreadClassification } from "#shared/types/library.ts";

export type ThreadVisibilityPurpose = "root" | "child" | "ordinary" | "diagnostic";
export const visibleRoles = {
  root: ["user-root"],
  child: ["delegated-child"],
  ordinary: ["user-root", "delegated-child"],
  diagnostic: ["user-root", "delegated-child", "internal", "unresolved"],
} as const;
export function isThreadVisible(
  classification: ThreadClassification,
  purpose: ThreadVisibilityPurpose = "ordinary",
): boolean {
  return (visibleRoles[purpose] as readonly string[]).includes(classification.visibility);
}
