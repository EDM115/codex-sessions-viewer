import { Virtualizer } from "@tanstack/vue-virtual";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { h, nextTick, ref } from "vue";

import TurnMinimap from "../../../app/components/conversation/TurnMinimap.vue";
import { useScrollAnchoring } from "../../../app/composables/useScrollAnchoring.ts";
import { installConversationScrollPolicy } from "../../../shared/timeline/virtualizer.ts";
import type { TurnNavigatorItem } from "../../../shared/types/conversation.ts";

function rectangle(top: number, height = 200): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 100,
    width: 100,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

describe("timeline mounted range recovery", () => {
  it("recovers an unmounted stable ID and does not restore after newer user input", async () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () => rectangle(50, 800);
    const anchor = document.createElement("div");
    anchor.dataset.anchorTurnId = "deep-turn";
    anchor.getBoundingClientRect = () => rectangle(1_500 - container.scrollTop);
    const anchoring = useScrollAnchoring(
      ref(container),
      () => 1_450,
      () => ({ turnId: "deep-turn", top: -20 }),
    );
    expect(anchoring.capture()?.turnId).toBe("deep-turn");
    const restoring = anchoring.restore({ turnId: "deep-turn", top: -20 });
    await Promise.resolve();
    await Promise.resolve();
    expect(container.scrollTop).toBe(1_470);
    container.append(anchor);
    await restoring;
    expect(container.scrollTop).toBe(1_470);
    const snapshot = anchoring.capture();
    const pending = anchoring.restore(snapshot);
    anchoring.cancel();
    container.scrollTop = 300;
    await pending;
    expect(container.scrollTop).toBe(300);
  });

  it("keeps the virtual reading identity while reflowed DOM rows overlap their estimated positions", async () => {
    const container = document.createElement("div");
    container.scrollTop = 696;
    container.getBoundingClientRect = () => rectangle(0, 800);
    const instance = new Virtualizer<HTMLElement, Element>({
      count: 2,
      getItemKey: (index) => (index === 0 ? "previous" : "reading"),
      getScrollElement: () => null,
      estimateSize: () => 520,
      initialRect: { width: 900, height: 800 },
      initialOffset: 696,
      observeElementRect: () => () => undefined,
      observeElementOffset: () => () => undefined,
      scrollToFn: (offset, { adjustments = 0 }) => {
        container.scrollTop = offset + adjustments;
      },
    });
    installConversationScrollPolicy(instance);
    instance.getTotalSize();
    for (const [index, id] of ["previous", "reading"].entries()) {
      const row = document.createElement("div");
      row.dataset.anchorTurnId = id;
      // The DOM already reflowed to 1112px, but ResizeObserver has not delivered it.
      row.getBoundingClientRect = () =>
        rectangle((instance.measurementsCache[index]?.start ?? 0) - container.scrollTop, 1_112);
      container.append(row);
    }
    const anchoring = useScrollAnchoring(
      ref(container),
      () => null,
      () => {
        const row = instance.getVirtualItemForOffset(container.scrollTop);
        return row === undefined
          ? null
          : { turnId: String(row.key), top: row.start - container.scrollTop };
      },
    );
    const snapshot = anchoring.capture();
    expect(snapshot?.turnId).toBe("reading");
    expect(snapshot?.top).toBe(-176);
    instance.resizeItem(0, 1_112);
    instance.getTotalSize();
    expect(container.scrollTop).toBe(1_288);
    await anchoring.restore(snapshot);
    expect(container.scrollTop).toBe(1_288);
    expect(container.lastElementChild?.getBoundingClientRect().top).toBe(-176);
  });

  it("windows thousands of markers and only reads assistant prose for the active preview", async () => {
    const assistant = vi.fn<(index: number) => string>((index) => `Assistant preview ${index}`);
    const items: TurnNavigatorItem[] = Array.from({ length: 2_000 }, (_, index) => ({
      turnId: `turn-${index}`,
      index,
      userMessageId: null,
      promptPreview: `Prompt ${index}`,
      get assistantPreview() {
        return assistant(index);
      },
      proseLengthBucket: 2,
      createdAt: null,
    }));
    const currentTurnId = ref("turn-0");
    // Render through a parent: VTU inspects every getter when given nested mount props.
    const wrapper = mount(
      { render: () => h(TurnMinimap, { items, currentTurnId: currentTurnId.value }) },
      { attachTo: document.body },
    );
    expect(wrapper.findAll("button").length).toBeLessThan(80);
    expect(assistant).not.toHaveBeenCalled();
    currentTurnId.value = "turn-1000";
    await nextTick();
    expect(wrapper.findAll("button").length).toBeLessThan(80);
    expect(assistant).not.toHaveBeenCalled();
    await wrapper.get('[data-turn-id="turn-1000"]').trigger("keydown", { key: "End" });
    expect(wrapper.getComponent(TurnMinimap).emitted("select")?.at(-1)).toEqual(["turn-1999"]);
    expect(document.activeElement).toBe(wrapper.get('[data-turn-id="turn-1999"]').element);
    expect(assistant.mock.calls).toEqual([[1_999]]);
    expect(wrapper.get('[role="tooltip"]').text()).toContain("Assistant preview 1999");
    wrapper.unmount();
  });
});
