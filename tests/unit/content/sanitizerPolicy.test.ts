import { describe, expect, it } from "vitest";

import { parseRichText } from "../../../server/content/parseRichText.ts";
import { sanitizeSvg } from "../../../server/content/sanitizeSvg.ts";

describe("sanitizer policy", () => {
  it("drops active document containers and their bodies while retaining adjacent prose", async () => {
    const { document } = await parseRichText(
      "<p>Before safe prose.</p><form>hidden-form</form><object>hidden-object</object><canvas>hidden-canvas</canvas><template>hidden-template</template><style>hidden-style</style><p>After safe prose.</p>",
    );
    const serialized = JSON.stringify(document);
    expect(serialized).toContain("Before safe prose.");
    expect(serialized).toContain("After safe prose.");
    expect(serialized).not.toMatch(/hidden-(?:form|object|canvas|template|style)/u);
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
