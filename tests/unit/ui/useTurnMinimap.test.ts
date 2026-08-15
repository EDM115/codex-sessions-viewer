import { describe, expect, it } from "vitest";
import { ref } from "vue";

import { useTurnMinimap } from "../../../app/composables/useTurnMinimap.ts";
import type { TurnNavigatorItem } from "../../../shared/types/conversation.ts";

function item(index: number): TurnNavigatorItem {
  return {
    turnId: `turn-${index}`,
    index,
    userMessageId: null,
    promptPreview: "Prompt",
    assistantPreview: "Response",
    proseLengthBucket: 2,
    createdAt: null,
  };
}

describe("turn minimap composable", () => {
  it("tracks reactive items and updates only for supported destinations", () => {
    const items = ref([item(1), item(2), item(3)]);
    const minimap = useTurnMinimap(items, "missing-turn");

    expect(minimap.move("PageDown")).toBeNull();
    expect(minimap.currentTurnId.value).toBe("missing-turn");
    expect(minimap.move("ArrowDown")?.turnId).toBe("turn-2");
    expect(minimap.currentTurnId.value).toBe("turn-2");
    minimap.setCurrent("turn-3");
    expect(minimap.move("End")?.turnId).toBe("turn-3");
    items.value = [];
    expect(minimap.move("Home")).toBeNull();
    minimap.setCurrent(null);
    expect(minimap.currentTurnId.value).toBeNull();
  });
});
