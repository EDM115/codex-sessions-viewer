import * as z from "zod";

import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import { readStableBytes } from "../ingestion/stableRead.ts";

const localProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootPaths: z.array(z.string()),
});

const globalStateSchema = z.object({
  "local-projects": z.record(z.string(), localProjectSchema).optional().default({}),
  "pinned-thread-ids": z.array(z.string().min(1)).optional().default([]),
});

export interface GlobalProjectMetadata {
  id: string;
  name: string;
  rootPaths: string[];
}

export interface GlobalStateMetadata {
  projects: GlobalProjectMetadata[];
  pinnedThreadIds: string[];
}

export interface GlobalStateResult {
  metadata: GlobalStateMetadata;
  diagnostics: ViewerDiagnostic[];
}

const emptyMetadata: GlobalStateMetadata = { projects: [], pinnedThreadIds: [] };

function invalidGlobalState(path: string, message: string): GlobalStateResult {
  return {
    metadata: emptyMetadata,
    diagnostics: [
      createViewerDiagnostic({
        code: "metadata.snapshot_invalid",
        severity: "warning",
        area: "metadata",
        message,
        path,
      }),
    ],
  };
}

export async function readGlobalState(path: string): Promise<GlobalStateResult> {
  const stable = await readStableBytes(path);
  if (stable.read.status !== "stable") {
    return invalidGlobalState(
      path,
      "Global Codex metadata changed while it was being read and will be retried.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(stable.bytes.toString("utf8"));
  } catch {
    return invalidGlobalState(path, "Global Codex metadata contains invalid JSON and was ignored.");
  }
  const parsed = globalStateSchema.safeParse(decoded);
  if (!parsed.success) {
    return invalidGlobalState(
      path,
      "Global Codex metadata has an unsupported shape and was ignored.",
    );
  }

  return {
    metadata: {
      projects: Object.values(parsed.data["local-projects"])
        .map(({ id, name, rootPaths }) => ({ id, name, rootPaths }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
      pinnedThreadIds: [...new Set(parsed.data["pinned-thread-ids"])].toSorted(),
    },
    diagnostics: [],
  };
}
