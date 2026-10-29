import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
describe("standalone project aliases", () => {
  it("resolves shared and server aliases with the real Node package resolver", () => {
    expect(require.resolve("#shared/types/conversation.ts").replaceAll("\\", "/")).toMatch(
      /\/shared\/types\/conversation\.ts$/u,
    );
    expect(require.resolve("#server/history/nativeItemAdapter.ts").replaceAll("\\", "/")).toMatch(
      /\/server\/history\/nativeItemAdapter\.ts$/u,
    );
  });
});
