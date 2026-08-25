import { describe, expect, it } from "vitest";

import type { StateMetadataSnapshot } from "../../../server/metadata/stateSnapshot.ts";
import {
  mergeSessionMetadata,
  selectPreferredSessionSource,
} from "../../../server/normalization/metadataMerge.ts";

const snapshot: StateMetadataSnapshot = {
  threads: [
    {
      id: "session-1",
      rolloutPath: "C:\\codex\\sessions\\one.jsonl",
      createdAt: 1,
      updatedAt: 2,
      source: "cli",
      modelProvider: "openai",
      cwd: "C:\\work",
      title: "Snapshot title",
      tokensUsed: 42,
      archived: true,
      archivedAt: 3,
      gitSha: "abc123",
      gitBranch: "main",
      gitOriginUrl: "https://example.test/repo.git",
      firstUserMessage: "Snapshot preview",
      model: "snapshot-model",
      reasoningEffort: "snapshot-effort",
      name: "  User-defined name  ",
      pinned: true,
      sectionId: "section-1",
    },
  ],
  sections: [{ id: "section-1", name: "Pinned work" }],
  spawnEdges: [
    { parentThreadId: "parent-1", childThreadId: "session-1", status: "completed" },
    { parentThreadId: "session-1", childThreadId: "child-1", status: "running" },
  ],
};

describe("session metadata merging", () => {
  it("applies title precedence and lets exact rollout model evidence beat snapshot fallback", () => {
    const merged = mergeSessionMetadata({
      sessionId: "session-1",
      sourcePath: "C:\\codex\\sessions\\one.jsonl",
      scope: "active",
      firstUserPreview: "First prompt",
      rolloutModels: ["gpt-current", "gpt-next"],
      rolloutReasoningEfforts: ["medium", "high"],
      sessionIndexEntries: [
        {
          id: "session-1",
          threadName: "Index name",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      stateSnapshot: snapshot,
    });

    expect(merged).toMatchObject({
      title: "User-defined name",
      scope: "active",
      cwd: "C:\\work",
      gitBranch: "main",
      gitSha: "abc123",
      gitOriginUrl: "https://example.test/repo.git",
      models: ["gpt-current", "gpt-next"],
      reasoningEfforts: ["medium", "high"],
      pinned: true,
      sectionName: "Pinned work",
      parentThreadId: "parent-1",
      childThreadIds: ["child-1"],
    });
  });

  it("falls through index, snapshot title, prompt preview, and session ID without blank overrides", () => {
    const unnamedSnapshot: StateMetadataSnapshot = {
      ...snapshot,
      threads: [{ ...snapshot.threads[0]!, name: "  ", title: "Snapshot title" }],
    };
    const fromIndex = mergeSessionMetadata({
      sessionId: "session-1",
      sourcePath: "one.jsonl",
      scope: "archived",
      firstUserPreview: "Prompt",
      rolloutModels: [],
      rolloutReasoningEfforts: [],
      sessionIndexEntries: [
        { id: "session-1", threadName: "Index title", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      stateSnapshot: unnamedSnapshot,
    });
    const fromSnapshot = mergeSessionMetadata({
      sessionId: "session-1",
      sourcePath: "one.jsonl",
      scope: "archived",
      firstUserPreview: "Prompt",
      rolloutModels: [],
      rolloutReasoningEfforts: [],
      sessionIndexEntries: [],
      stateSnapshot: unnamedSnapshot,
    });
    const fromPrompt = mergeSessionMetadata({
      sessionId: "missing",
      sourcePath: "missing.jsonl",
      scope: "active",
      firstUserPreview: "  Prompt title  ",
      rolloutModels: [],
      rolloutReasoningEfforts: [],
      sessionIndexEntries: [],
      stateSnapshot: null,
    });
    const fromId = mergeSessionMetadata({
      sessionId: "missing",
      sourcePath: "missing.jsonl",
      scope: "active",
      firstUserPreview: "",
      rolloutModels: [],
      rolloutReasoningEfforts: [],
      sessionIndexEntries: [],
      stateSnapshot: null,
    });

    expect(fromIndex.title).toBe("Index title");
    expect(fromIndex.models).toEqual(["snapshot-model"]);
    expect(fromIndex.reasoningEfforts).toEqual(["snapshot-effort"]);
    expect(fromSnapshot.title).toBe("Snapshot title");
    expect(fromPrompt.title).toBe("Prompt title");
    expect(fromId.title).toBe("missing");
  });
});

describe("duplicate source reconciliation", () => {
  it("selects the newest stable complete source and derives scope from that path", () => {
    const result = selectPreferredSessionSource([
      {
        sessionId: "session-1",
        path: "C:\\codex\\sessions\\old.jsonl",
        scope: "active",
        mtimeMs: 100,
        stable: true,
        complete: true,
      },
      {
        sessionId: "session-1",
        path: "C:\\codex\\archived_sessions\\new.jsonl",
        scope: "archived",
        mtimeMs: 200,
        stable: true,
        complete: true,
      },
      {
        sessionId: "session-1",
        path: "C:\\codex\\sessions\\changing.jsonl",
        scope: "active",
        mtimeMs: 300,
        stable: false,
        complete: true,
      },
      {
        sessionId: "session-1",
        path: "C:\\codex\\sessions\\incomplete.jsonl",
        scope: "active",
        mtimeMs: 400,
        stable: true,
        complete: false,
      },
    ]);

    expect(result.selected).toMatchObject({
      path: "C:\\codex\\archived_sessions\\new.jsonl",
      scope: "archived",
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "source.duplicate_session",
        sessionId: "session-1",
        path: "C:\\codex\\archived_sessions\\new.jsonl",
        details: {
          candidateCount: 4,
          selectedPath: "C:\\codex\\archived_sessions\\new.jsonl",
        },
      }),
    ]);
  });

  it("breaks equal-mtime ties by normalized path", () => {
    const result = selectPreferredSessionSource([
      {
        sessionId: "session-1",
        path: "C:\\z\\..\\a.jsonl",
        scope: "active",
        mtimeMs: 100,
        stable: true,
        complete: true,
      },
      {
        sessionId: "session-1",
        path: "C:\\b.jsonl",
        scope: "archived",
        mtimeMs: 100,
        stable: true,
        complete: true,
      },
    ]);

    expect(result.selected?.path).toBe("C:\\z\\..\\a.jsonl");
  });

  it("returns no selected source while every candidate is unstable or incomplete", () => {
    const result = selectPreferredSessionSource([
      {
        sessionId: "session-1",
        path: "one.jsonl",
        scope: "active",
        mtimeMs: 100,
        stable: false,
        complete: true,
      },
      {
        sessionId: "session-1",
        path: "two.jsonl",
        scope: "archived",
        mtimeMs: 200,
        stable: true,
        complete: false,
      },
    ]);

    expect(result.selected).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
  });
});
