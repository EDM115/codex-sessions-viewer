import { describe, expect, it } from "vitest";

import { resolveThreadFields } from "#server/metadata/threadFields.ts";
import { mergeSessionMetadata } from "#server/normalization/metadataMerge.ts";

import { thread } from "../library/membershipFixtures.ts";

describe("catalog and selected/export metadata field precedence", () => {
  it("records independent native field sources and conflicting index provenance without using recompression time", () => {
    const native = thread("chat", {
      historyMode: "paginated",
      name: null,
      title: "Current native title",
      createdAt: 100,
      createdAtMs: 0,
      updatedAt: 200,
      updatedAtMs: 1001,
      recencyAt: 300,
      recencyAtMs: 500,
    });
    const index = {
      id: "chat",
      threadName: "Stale index title",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const fields = resolveThreadFields({
      id: "chat",
      thread: native,
      index,
      knownTitle: "Cached title",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(fields).toMatchObject({
      title: "Current native title",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:01.001Z",
      recencyAt: "1970-01-01T00:00:00.500Z",
      fieldSources: {
        title: "native.title",
        createdAt: "native.createdAtMs",
        updatedAt: "native.updatedAtMs",
        recencyAt: "native.recencyAtMs",
      },
      metadataConflicts: ["title", "updatedAt"],
    });
    const selected = mergeSessionMetadata({
      sessionId: "chat",
      sourcePath: "/fixture/sessions/chat.jsonl",
      scope: "active",
      firstUserPreview: "A Guardian-like action must not become the title",
      rolloutModels: [],
      rolloutReasoningEfforts: [],
      sessionIndexEntries: [index],
      stateSnapshot: { threads: [native], sections: [], spawnEdges: [] },
    });
    expect(selected).toMatchObject({
      title: fields.title,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
    });
  });

  it("uses legacy index names, retained known titles and stable IDs while leaving unknown times null", () => {
    expect(
      resolveThreadFields({
        id: "legacy",
        thread: thread("legacy", { name: " ", title: "Generated title" }),
        index: {
          id: "legacy",
          threadName: "Legacy human name",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }).title,
    ).toBe("Legacy human name");
    expect(resolveThreadFields({ id: "cached", knownTitle: "Known title" })).toMatchObject({
      title: "Known title",
      createdAt: null,
      updatedAt: null,
      recencyAt: null,
      fieldSources: { title: "retained.title", createdAt: null, updatedAt: null, recencyAt: null },
    });
    expect(resolveThreadFields({ id: "unnamed" })).toMatchObject({
      title: "unnamed",
      fieldSources: { title: "thread.id" },
    });
    expect(
      resolveThreadFields({
        id: "paginated",
        historyMode: "paginated",
        knownTitle: "Retained native title",
        index: {
          id: "paginated",
          threadName: "Incompatible legacy index",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }).title,
    ).toBe("Retained native title");
  });
});
