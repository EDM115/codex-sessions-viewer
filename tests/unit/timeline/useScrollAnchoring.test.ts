import { describe, expect, it } from "vitest";

import {
  scrollAnchorAdjustment,
  shouldAdjustForMeasuredRow,
} from "../../../shared/timeline/scrollAnchoring.ts";

describe("scroll anchoring", () => {
  it("corrects scroll position by the anchor element's visual displacement", () => {
    expect(scrollAnchorAdjustment({ top: 84 }, { top: 284 })).toBe(200);
    expect(scrollAnchorAdjustment({ top: 84 }, { top: 44 })).toBe(-40);
  });

  it("adjusts measured rows above the viewport without shifting a visible tall row", () => {
    expect(shouldAdjustForMeasuredRow({ end: 480 }, 500)).toBe(true);
    expect(shouldAdjustForMeasuredRow({ end: 500 }, 500)).toBe(true);
    expect(shouldAdjustForMeasuredRow({ end: 500.01 }, 500)).toBe(false);
    expect(shouldAdjustForMeasuredRow({ end: 900 }, 500)).toBe(false);
    expect(shouldAdjustForMeasuredRow({ end: 480 }, null)).toBe(false);
  });
});
