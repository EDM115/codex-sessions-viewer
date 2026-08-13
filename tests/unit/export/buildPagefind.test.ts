import { describe, expect, it } from "vitest";

import { createPagefindTurnRecords } from "../../../server/export/buildPagefind.ts";
import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

describe("Pagefind turn records", () => {
  it("creates one direct record per turn with flat metadata and filter arrays", async () => {
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:\\codex\\sessions\\modern.jsonl",
      scope: "active",
      revision: "sha256:fixture",
    });

    const records = createPagefindTurnRecords([conversation]);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      url: "/session/11111111-1111-4111-8111-111111111111#turn-turn-1",
      language: "en",
      meta: {
        title: "Build the parser — Turn 1",
        sessionId: "11111111-1111-4111-8111-111111111111",
        turnId: "turn-1",
        date: "2026-01-01",
      },
      filters: {
        scope: ["active"],
        model: ["gpt-exact-1"],
        cwd: ["C:\\work\\viewer"],
        project: ["viewer"],
        tool: ["filesystem.read_file"],
        media: ["true"],
        date: ["2026-01-01"],
      },
    });
    expect(records[0]!.content).toContain("Build the parser");
    expect(records[0]!.content).toContain("The parser is ready.");
    expect(records[0]!.content).toContain("filesystem.read_file");
    expect(records[1]!.content).not.toContain("future_payload");
    expect(records[1]!.content).not.toContain("secret_blob");
  });
});
