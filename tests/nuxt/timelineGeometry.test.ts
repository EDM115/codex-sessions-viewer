import { mountSuspended } from "@nuxt/test-utils/runtime";
import { Virtualizer } from "@tanstack/vue-virtual";
import { describe, expect, it, vi } from "vitest";

import { installConversationScrollPolicy } from "#shared/timeline/virtualizer.ts";
import type { TurnNavigatorItem } from "#shared/types/conversation.ts";
import TurnMinimap from "~/components/conversation/TurnMinimap.vue";
import { useMeasuredConversationViewport } from "~/composables/useMeasuredConversationViewport.ts";
import { useScrollAnchoring } from "~/composables/useScrollAnchoring.ts";

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
  it("uses the measured turn anchor while the reading line is in leading padding", () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () => rectangle(0, 800);
    const turn = document.createElement("article");
    turn.dataset.anchorTurnId = "turn";
    turn.getBoundingClientRect = () => rectangle(0, 1000);
    const entry = document.createElement("article");
    entry.dataset.anchorEntry = "prompt";
    entry.getBoundingClientRect = () => rectangle(64, 100);
    turn.append(entry);
    container.append(turn);
    const anchoring = useScrollAnchoring(
      ref(container),
      () => 0,
      () => ({ turnId: "turn", top: 0 }),
    );
    expect(anchoring.capture()).toMatchObject({ turnId: "turn", top: 0 });
    expect(anchoring.capture()?.entry).toBeUndefined();
  });
  it.each(["message", "activity"])(
    "retains the reading %s and local offset through growth inside its turn and rejects a replaced source",
    async (kind) => {
      const container = document.createElement("div");
      container.scrollTop = 1100;
      container.getBoundingClientRect = () => rectangle(0, 800);
      const turn = document.createElement("article");
      turn.dataset.anchorTurnId = "huge-turn";
      turn.dataset.anchorSource = "physical:epoch-A";
      turn.getBoundingClientRect = () => rectangle(-container.scrollTop, 3000);
      let growth = 0;
      const entry = document.createElement("article");
      if (kind === "message") {
        entry.dataset.anchorEntry = "message:stable-alias";
        entry.dataset.messageId = "original-echo";
      } else {
        entry.dataset.entryId = "activity-1";
      }
      entry.getBoundingClientRect = () => rectangle(1000 + growth - container.scrollTop, 1000);
      turn.append(entry);
      container.append(turn);
      const anchoring = useScrollAnchoring(
        ref(container),
        () => 0,
        () => ({ turnId: "huge-turn", top: -container.scrollTop }),
      );
      const snapshot = anchoring.capture();
      if (kind === "message") {
        entry.dataset.messageId = "canonical-message";
      }
      growth = 450;
      await anchoring.restore(snapshot);
      expect(entry.getBoundingClientRect().top).toBe(-100);
      expect(container.scrollTop).toBe(1550);
      const beforeReplacement = anchoring.capture();
      turn.dataset.anchorSource = "physical:epoch-B";
      growth += 100;
      await anchoring.restore(beforeReplacement);
      expect(container.scrollTop).toBe(1550);
    },
  );

  it("does not rearm a target snapshot after input during its final measured frame", async () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () => rectangle(0, 800);
    const canvas = document.createElement("div");
    canvas.getBoundingClientRect = () => rectangle(-container.scrollTop, 2000);
    const target = document.createElement("article");
    target.dataset.anchorTurnId = "target";
    target.getBoundingClientRect = () => rectangle(-container.scrollTop, 1000);
    canvas.append(target);
    container.append(canvas);
    let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
    const wrapper = await mountSuspended({
      setup() {
        viewport = useMeasuredConversationViewport({
          keys: () => ["target"],
          surface: ref(container),
          canvas: ref(canvas),
          storageKey: "final-frame-cancellation",
          followEnabled: () => true,
        });
        return () => h("span");
      },
    });
    let frames = 0;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => {
        if (++frames === 4) {
          viewport.readInput(new WheelEvent("wheel", { deltaY: 240 }));
          container.scrollTop = 240;
        }
        callback(performance.now());
      });
      return frames + 1;
    });
    await viewport.target("target");
    expect(frames).toBeGreaterThanOrEqual(4);
    expect(container.scrollTop).toBe(240);
    expect(viewport.follow.value).toBe(false);
    wrapper.unmount();
  });

  it("remembers the current entry under the new input generation before a pointer control grows content", async () => {
    const container = document.createElement("div");
    container.scrollTop = 1100;
    container.getBoundingClientRect = () => rectangle(0, 800);
    const canvas = document.createElement("div");
    canvas.getBoundingClientRect = () => rectangle(-container.scrollTop, 3000);
    const turn = document.createElement("article");
    turn.dataset.anchorTurnId = "huge-turn";
    turn.getBoundingClientRect = () => rectangle(-container.scrollTop, 3000);
    let growth = 0;
    const entry = document.createElement("article");
    entry.dataset.anchorEntry = "reading-item";
    entry.getBoundingClientRect = () => rectangle(1000 + growth - container.scrollTop, 1000);
    turn.append(entry);
    canvas.append(turn);
    container.append(canvas);
    let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
    const wrapper = await mountSuspended({
      setup() {
        viewport = useMeasuredConversationViewport({
          keys: () => ["huge-turn"],
          surface: ref(container),
          canvas: ref(canvas),
          storageKey: "pointer-growth",
          followEnabled: () => true,
        });
        return () => h("span");
      },
    });
    container.scrollTop = 1100;
    expect(entry.getBoundingClientRect().top).toBe(-100);
    viewport.readInput(new PointerEvent("pointerdown"));
    const superseded = viewport.settle();
    viewport.readInput(new PointerEvent("pointerdown"));
    growth = 450;
    await viewport.settle();
    await superseded;
    expect(entry.getBoundingClientRect().top).toBe(-100);
    wrapper.unmount();
  });

  it("remembers actual reader movement immediately after cancelling an in-flight anchor restore", async () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () => rectangle(0, 800);
    const anchoring = useScrollAnchoring(
      ref(container),
      () => 0,
      () => ({ turnId: "turn", top: -container.scrollTop }),
    );
    const pending = anchoring.restore({ turnId: "turn", top: 0 });
    anchoring.cancel();
    anchoring.remember();
    container.scrollTop = 300;
    anchoring.remember();
    expect(anchoring.snapshot?.top).toBe(-300);
    expect(anchoring.active).toBe(false);
    await pending;
    expect(container.scrollTop).toBe(300);
  });
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
    const wrapper = await mountSuspended(
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
