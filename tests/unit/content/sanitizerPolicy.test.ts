import { describe, expect, it } from "vitest";

import { richTextSanitizeSchema } from "../../../server/content/sanitizeSchema.ts";
import { sanitizeSvg } from "../../../server/content/sanitizeSvg.ts";

describe("sanitizer policy", () => {
  it("keeps only explicit network protocols and strips active document containers", () => {
    expect(richTextSanitizeSchema.protocols).toMatchObject({
      href: ["http", "https", "mailto"],
      src: ["http", "https", "data"],
    });
    expect(richTextSanitizeSchema.strip).toEqual(
      expect.arrayContaining([
        "script",
        "style",
        "iframe",
        "object",
        "embed",
        "form",
        "audio",
        "video",
        "canvas",
        "template",
      ]),
    );
  });

  it("rejects non-SVG input and strips scripts, events, external references, and animation", async () => {
    await expect(sanitizeSvg("plain text")).resolves.toBeNull();
    const sanitized = await sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10">
        <script>alert(1)</script>
        <image href="https://evil.example/pixel.png" />
        <animate attributeName="x" values="0;10" />
        <path id="safe" d="M0 0L10 10" stroke="url(#paint)" />
      </svg>
    `);

    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("<path");
    expect(sanitized).not.toMatch(/script|onload|evil\.example|animate/iu);
  });

  it("returns null when malformed SVG-looking input cannot produce an SVG root", async () => {
    await expect(sanitizeSvg("before <svg broken")).resolves.toBeNull();
  });
});
