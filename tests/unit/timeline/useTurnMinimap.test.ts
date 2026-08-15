import { describe, expect, it } from "vitest";

import {
  activeVirtualRowIndex,
  markerWidthForBucket,
  minimapDestinationIndex,
  minimapPreview,
} from "../../../shared/timeline/turnMinimap.ts";
import type { TurnNavigatorItem } from "../../../shared/types/conversation.ts";

const item: TurnNavigatorItem = {
  turnId: "turn-4",
  index: 4,
  userMessageId: "message-4",
  promptPreview: "  Keep the prompt on one line.  ",
  assistantPreview:
    "First assistant line.\nSecond assistant line.\nThird assistant line.\nFourth line.",
  proseLengthBucket: 3,
  createdAt: "2026-08-15T09:00:00.000Z",
};

describe("turn minimap", () => {
  it("keeps a tall containing turn active until the reading line crosses its end", () => {
    const rows = [
      { index: 4, start: 0, end: 1_000 },
      { index: 5, start: 1_000, end: 1_200 },
    ];

    expect(activeVirtualRowIndex(rows, 800)).toBe(4);
    expect(activeVirtualRowIndex(rows, 1_050)).toBe(5);
  });

  it("maps the four prose buckets to stable increasing marker widths", () => {
    const buckets: TurnNavigatorItem["proseLengthBucket"][] = [1, 2, 3, 4];
    expect(buckets.map(markerWidthForBucket)).toEqual([18, 30, 44, 60]);
  });

  it("builds previews exclusively from navigator prose fields", () => {
    expect(minimapPreview(item)).toEqual({
      prompt: "Keep the prompt on one line.",
      assistant: "First assistant line. Second assistant line. Third assistant line. Fourth line.",
    });
  });

  it("supports arrows plus Home and End without escaping the list", () => {
    expect(minimapDestinationIndex("ArrowDown", 3, 5)).toBe(4);
    expect(minimapDestinationIndex("ArrowDown", 4, 5)).toBe(4);
    expect(minimapDestinationIndex("ArrowUp", 0, 5)).toBe(0);
    expect(minimapDestinationIndex("Home", 3, 5)).toBe(0);
    expect(minimapDestinationIndex("End", 1, 5)).toBe(4);
    expect(minimapDestinationIndex("PageDown", 1, 5)).toBeNull();
  });
});
