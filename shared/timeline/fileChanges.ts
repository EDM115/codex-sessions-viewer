import type { FileChange } from "../types/conversation.ts";

export function fullFileLines(content: string): string[] {
  if (content === "") {
    return [];
  }
  const lines = content.split(/\r?\n/u);
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}
export function fileChangeLineCounts(change: {
  kind: "add" | "delete" | "update";
  content: string | null;
  diff: string | null;
}): Pick<FileChange, "addedLines" | "removedLines"> {
  if (change.kind === "add") {
    return {
      addedLines: change.content === null ? null : fullFileLines(change.content).length,
      removedLines: 0,
    };
  }
  if (change.kind === "delete") {
    return {
      addedLines: 0,
      removedLines: change.content === null ? null : fullFileLines(change.content).length,
    };
  }
  if (change.diff === null) {
    return { addedLines: null, removedLines: null };
  }
  let addedLines = 0,
    removedLines = 0,
    inHunk = false;
  for (const line of change.diff.split(/\r?\n/u)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) {
      continue;
    }
    if (line.startsWith("+")) {
      addedLines += 1;
    }
    if (line.startsWith("-")) {
      removedLines += 1;
    }
  }
  return { addedLines, removedLines };
}
export function fileLineCountLabel(file: Pick<FileChange, "addedLines" | "removedLines">): string {
  return file.addedLines === null || file.removedLines === null
    ? "Line counts unavailable"
    : `+${file.addedLines} −${file.removedLines}`;
}
