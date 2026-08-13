import { describe, expect, it } from "vitest";

import { highlightCode } from "../../../server/content/highlightCode.ts";

describe("code highlighting", () => {
  it("returns a constrained Shiki AST without changing source code", async () => {
    const source = "const answer: number = 42";
    const highlighted = await highlightCode(source, "ts");

    expect(highlighted).not.toBeNull();
    expect(JSON.stringify(highlighted)).toContain("answer");
    expect(JSON.stringify(highlighted)).toContain("#");
    expect(source).toBe("const answer: number = 42");
  });

  it("falls back cleanly for an unknown language", async () => {
    await expect(highlightCode("plain <source>", "made-up-language")).resolves.toBeNull();
  });
});
