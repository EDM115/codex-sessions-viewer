import { Virtualizer } from "@tanstack/vue-virtual";
import { describe, expect, it, vi } from "vitest";

import { installConversationScrollPolicy } from "../../../shared/timeline/virtualizer.ts";

function fixture(ids = Array.from({ length: 100 }, (_, index) => `turn-${index}`)) {
  const scroll = vi.fn<Virtualizer<HTMLElement, Element>["options"]["scrollToFn"]>();
  const instance = new Virtualizer<HTMLElement, Element>({
    count: ids.length,
    getItemKey: (index) => ids[index] ?? index,
    getScrollElement: () => null,
    estimateSize: () => 520,
    initialRect: { width: 900, height: 800 },
    initialOffset: 600,
    observeElementRect: () => () => undefined,
    observeElementOffset: () => () => undefined,
    scrollToFn: scroll,
  });
  installConversationScrollPolicy(instance);
  instance.getTotalSize();
  return { instance, scroll };
}

function measurement(instance: Virtualizer<HTMLElement, Element>, index: number) {
  instance.getTotalSize();
  const row = instance.measurementsCache[index];
  if (row === undefined) {
    throw new Error(`Missing measurement ${index}`);
  }
  return row;
}

describe("installed TanStack conversation policy", () => {
  it("invokes the instance policy on first measurement and subsequent backward resize", () => {
    const { instance, scroll } = fixture();
    const policy = vi.fn<
      NonNullable<Virtualizer<HTMLElement, Element>["shouldAdjustScrollPositionOnItemSizeChange"]>
    >(instance.shouldAdjustScrollPositionOnItemSizeChange);
    instance.shouldAdjustScrollPositionOnItemSizeChange = policy;
    instance.resizeItem(1, 1_000);
    expect(policy).toHaveBeenCalledOnce();
    expect(scroll).not.toHaveBeenCalled();
    instance.scrollDirection = "backward";
    instance.resizeItem(0, 600);
    expect(scroll.mock.calls.at(-1)?.[1].adjustments).toBe(80);
    instance.getTotalSize();
    instance.scrollOffset = 600;
    instance.resizeItem(0, 640);
    expect(policy).toHaveBeenCalledTimes(3);
    // A row ending exactly at the fold is entirely above it, including backward movement.
    expect(scroll.mock.calls.at(-1)?.[1].adjustments).toBe(40);
  });

  it("compares measured row positions against the canvas origin inside the scroller", () => {
    const { instance, scroll } = fixture();
    installConversationScrollPolicy(instance, () => 300);
    instance.resizeItem(0, 600);
    expect(scroll).not.toHaveBeenCalled();
    instance.getTotalSize();
    instance.scrollOffset = 900;
    instance.resizeItem(0, 640);
    expect(scroll.mock.calls.at(-1)?.[1].adjustments).toBe(40);
  });

  it("retains learned sizes by stable ID across append, prepend and target windows", () => {
    const ids = Array.from({ length: 100 }, (_, index) => `turn-${index}`);
    const { instance } = fixture(ids);
    for (let index = 0; index < 100; index++) {
      instance.getTotalSize();
      instance.resizeItem(index, index % 2 === 0 ? 1_000 : 140);
    }
    const priorStart = measurement(instance, 30).start;
    instance.setOptions({
      ...instance.options,
      count: 120,
      getItemKey: (index) => `turn-${index}`,
    });
    expect(measurement(instance, 30).start).toBe(priorStart);
    expect(instance.itemSizeCache.size).toBe(100);
    instance.setOptions({
      ...instance.options,
      count: 122,
      getItemKey: (index) => (index < 2 ? `earlier-${index}` : `turn-${index - 2}`),
    });
    expect(measurement(instance, 32).start).toBe(priorStart + 1_040);
    expect(measurement(instance, 32).size).toBe(1_000);
    instance.setOptions({
      ...instance.options,
      count: 5,
      getItemKey: (index) => `turn-${index + 28}`,
    });
    expect(measurement(instance, 2).size).toBe(1_000);
    expect(instance.getTotalSize()).toBe(3_280);
  });
});
