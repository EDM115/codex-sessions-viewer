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
  it("requalifies a remembered choice on source replacement and releases missing entry or turn keys", () => {
    const container = document.createElement("div");
    const target = document.createElement("article");
    const entry = document.createElement("article");
    let turnId = "first";
    let entryTop = 10;
    target.dataset.anchorTurnId = turnId;
    target.dataset.anchorSource = "source:epoch-A";
    entry.dataset.anchorEntry = "first-entry";
    container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
    target.getBoundingClientRect = () => new DOMRect(0, -100, 800, 1000);
    entry.getBoundingClientRect = () => new DOMRect(0, entryTop, 800, 200);
    target.append(entry);
    container.append(target);
    container.scrollTop = 100;
    const anchoring = useScrollAnchoring(
      ref(container),
      (key) => (key === turnId ? 0 : null),
      () => ({ turnId, top: -container.scrollTop }),
    );
    const fallback = anchoring.capture();
    expect(fallback?.entry).toBeUndefined();
    entryTop = -20;
    expect(anchoring.capture(fallback)?.entry).toBeUndefined();
    target.dataset.anchorSource = "source:epoch-B";
    const replaced = anchoring.capture(fallback);
    expect(replaced).toMatchObject({
      source: "source:epoch-B",
      entry: { key: "first-entry", top: -20 },
    });
    entry.remove();
    expect(anchoring.capture(replaced)?.entry).toBeUndefined();
    target.remove();
    const replacement = document.createElement("article");
    turnId = "second";
    replacement.dataset.anchorTurnId = turnId;
    replacement.dataset.anchorSource = "source:epoch-C";
    replacement.getBoundingClientRect = () => new DOMRect(0, -100, 800, 1000);
    entry.dataset.anchorEntry = "second-entry";
    replacement.append(entry);
    container.append(replacement);
    expect(anchoring.capture(replaced)).toMatchObject({
      turnId: "second",
      source: "source:epoch-C",
      entry: { key: "second-entry", top: -20 },
    });
    anchoring.cancel();
    expect(anchoring.capture(fallback)?.inputVersion).toBe(1);
  });
  it.each([false, true])(
    "retains the chosen anchor kind across owned surface movement until fresh reader movement (moved=%s)",
    async (moved) => {
      const container = document.createElement("div");
      const canvas = document.createElement("div");
      const target = document.createElement("article");
      const entry = document.createElement("article");
      target.dataset.anchorTurnId = "target";
      entry.dataset.anchorEntry = "reading-entry";
      let surfaceTop = 100;
      let growth = 0;
      container.getBoundingClientRect = () => new DOMRect(0, surfaceTop, 800, 800);
      canvas.getBoundingClientRect = () =>
        new DOMRect(0, surfaceTop + 32 - container.scrollTop, 800, 2000);
      target.getBoundingClientRect = () =>
        new DOMRect(0, surfaceTop + 32 - container.scrollTop, 800, 1000 + growth);
      entry.getBoundingClientRect = () =>
        new DOMRect(0, target.getBoundingClientRect().top + 145.59375 + growth, 800, 135.46875);
      target.append(entry);
      canvas.append(target);
      container.append(canvas);
      let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
      const wrapper = await mountSuspended({
        setup() {
          viewport = useMeasuredConversationViewport({
            keys: () => ["target"],
            surface: ref(container),
            canvas: ref(canvas),
            storageKey: `stable-anchor-kind-${moved}`,
            followEnabled: () => true,
            sourceIdentity: () => "source:epoch-A",
          });
          return () => h("span");
        },
      });
      try {
        await viewport.target("target");
        container.scrollTop += 96;
        viewport.scroll();
        expect(entry.getBoundingClientRect().top).toBeGreaterThan(surfaceTop);
        surfaceTop += 61.59375;
        await viewport.settle();
        expect(entry.getBoundingClientRect().top).toBeLessThan(surfaceTop);
        expect(entry.getBoundingClientRect().bottom).toBeGreaterThan(surfaceTop);
        if (moved) {
          container.scrollTop += 10;
          viewport.scroll();
        }
        const chosen = moved ? entry : target;
        const before = chosen.getBoundingClientRect().top;
        viewport.capture();
        growth += 55.59375;
        await viewport.settle();
        expect(chosen.getBoundingClientRect().top).toBe(before);
        expect(viewport.follow.value).toBe(false);
      } finally {
        wrapper.unmount();
      }
    },
  );
  it("observes unowned movement during an active target restore without arming follow", async () => {
    const container = document.createElement("div");
    const canvas = document.createElement("div");
    const target = document.createElement("article");
    target.dataset.anchorTurnId = "target";
    container.getBoundingClientRect = () => rectangle(0, 800);
    canvas.getBoundingClientRect = () => rectangle(-container.scrollTop, 2000);
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
          storageKey: "unowned-target-movement",
          followEnabled: () => true,
        });
        return () => h("span");
      },
    });
    let frames = 0;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => {
        if (++frames === 4) {
          container.scrollTop = 240;
          viewport.scroll();
        }
        callback(performance.now());
      });
      return frames + 1;
    });
    try {
      await viewport.target("target");
      expect(container.scrollTop).toBe(240);
      expect(viewport.follow.value).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
  it.each([false, true])(
    "retains screen position when controls move the scroll surface (captured=%s)",
    async (captured) => {
      const container = document.createElement("div");
      const canvas = document.createElement("div");
      const target = document.createElement("article");
      target.dataset.anchorTurnId = "target";
      let surfaceTop = 100;
      container.getBoundingClientRect = () => rectangle(surfaceTop, 800);
      canvas.getBoundingClientRect = () => rectangle(surfaceTop + 32 - container.scrollTop, 2000);
      target.getBoundingClientRect = () => rectangle(surfaceTop + 32 - container.scrollTop, 1000);
      canvas.append(target);
      container.append(canvas);
      let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
      const wrapper = await mountSuspended({
        setup() {
          viewport = useMeasuredConversationViewport({
            keys: () => ["target"],
            surface: ref(container),
            canvas: ref(canvas),
            storageKey: `moving-surface-${captured}`,
            followEnabled: () => true,
          });
          return () => h("span");
        },
      });
      try {
        await viewport.target("target");
        const before = target.getBoundingClientRect().top;
        if (captured) {
          viewport.capture();
        }
        surfaceTop += 61.59375;
        await viewport.settle();
        expect(target.getBoundingClientRect().top).toBe(before);
        expect(viewport.origin.value).toBe(32);
      } finally {
        wrapper.unmount();
      }
    },
  );
  it("keeps owned latest writes active but deactivates following for unowned movement", async () => {
    const container = document.createElement("div");
    const canvas = document.createElement("div");
    container.append(canvas);
    container.getBoundingClientRect = () => rectangle(0, 800);
    canvas.getBoundingClientRect = () => rectangle(-container.scrollTop, 1000);
    vi.spyOn(container, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(container, "scrollHeight", "get").mockReturnValue(1000);
    let position = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => position,
      set: (value: number) => {
        position = Math.max(0, Math.min(200, value));
      },
    });
    let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
    const wrapper = await mountSuspended({
      setup() {
        viewport = useMeasuredConversationViewport({
          keys: () => ["target"],
          surface: ref(container),
          canvas: ref(canvas),
          storageKey: "owned-latest-writes",
          followEnabled: () => true,
        });
        return () => h("span");
      },
    });
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => {
        viewport.scroll();
        callback(performance.now());
      });
      return 1;
    });
    try {
      const owner = viewport.beginNavigation();
      await viewport.latest(owner);
      expect(owner.isCurrent()).toBe(true);
      expect(viewport.follow.value).toBe(true);
      container.scrollTop = 104;
      viewport.scroll();
      expect(viewport.follow.value).toBe(false);
      expect(container.scrollTop).toBe(104);
    } finally {
      wrapper.unmount();
    }
  });
  it.each([
    "control",
    "control-no-touch",
    "control-space",
    "control-enter",
    "wheel",
    "keyboard",
    "touch",
    "scrollbar",
  ])("separates navigation cancellation from follow intent for %s input", async (kind) => {
    const container = document.createElement("div");
    const canvas = document.createElement("div");
    const control = document.createElement("button");
    container.append(canvas);
    canvas.append(control);
    container.getBoundingClientRect = () => ({ ...rectangle(0, 800), width: 300, right: 300 });
    canvas.getBoundingClientRect = () => rectangle(-container.scrollTop, 1000);
    vi.spyOn(container, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(container, "clientWidth", "get").mockReturnValue(280);
    vi.spyOn(container, "scrollHeight", "get").mockReturnValue(1000);
    let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
    const wrapper = await mountSuspended({
      setup() {
        viewport = useMeasuredConversationViewport({
          keys: () => ["selected"],
          surface: ref(container),
          canvas: ref(canvas),
          storageKey: `follow-input-${kind}`,
          followEnabled: () => true,
          canFollow: () => true,
        });
        return () => h("span");
      },
    });
    try {
      const owner = viewport.beginNavigation();
      container.scrollTop = 200;
      if (kind === "control-space" || kind === "control-enter") {
        control.addEventListener("keydown", (event) => viewport.readInput(event), { once: true });
        control.dispatchEvent(
          new KeyboardEvent("keydown", { key: kind === "control-space" ? " " : "Enter" }),
        );
      } else if (kind === "control" || kind === "control-no-touch" || kind === "scrollbar") {
        if (kind === "control-no-touch") {
          vi.stubGlobal("TouchEvent", undefined);
          viewport.readInput(new PointerEvent("pointerdown"));
        } else {
          const target = kind.startsWith("control") ? control : container;
          target.addEventListener("pointerdown", (event) => viewport.readInput(event), {
            once: true,
          });
          target.dispatchEvent(
            new PointerEvent("pointerdown", {
              clientX: kind.startsWith("control") ? 50 : 290,
              clientY: 100,
            }),
          );
        }
      } else if (kind === "wheel") {
        viewport.readInput(new WheelEvent("wheel", { deltaY: 1000 }));
      } else if (kind === "keyboard") {
        viewport.readInput(new KeyboardEvent("keydown", { key: "End" }));
      } else {
        const first = new Touch({ identifier: 1, target: container, clientX: 50, clientY: 100 });
        viewport.readInput(new TouchEvent("touchstart", { touches: [first] }));
        const moved = new Touch({ identifier: 1, target: container, clientX: 50, clientY: 80 });
        viewport.readInput(new TouchEvent("touchmove", { touches: [moved] }));
      }
      expect(owner.isCurrent()).toBe(false);
      viewport.scroll();
      expect(viewport.follow.value).toBe(!kind.startsWith("control"));
    } finally {
      wrapper.unmount();
      vi.unstubAllGlobals();
    }
  });
  it("arms follow only at the logical history tail, not the bottom of an older loaded target", async () => {
    const container = document.createElement("div");
    const canvas = document.createElement("div");
    container.append(canvas);
    container.getBoundingClientRect = () => rectangle(0, 800);
    canvas.getBoundingClientRect = () => rectangle(-container.scrollTop, 1000);
    vi.spyOn(container, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(container, "scrollHeight", "get").mockReturnValue(1000);
    let atHistoryTail = false;
    let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
    const wrapper = await mountSuspended({
      setup() {
        viewport = useMeasuredConversationViewport({
          keys: () => ["selected"],
          surface: ref(container),
          canvas: ref(canvas),
          storageKey: "logical-history-tail",
          followEnabled: () => true,
          canFollow: () => atHistoryTail,
        });
        return () => h("span");
      },
    });
    try {
      container.scrollTop = 200;
      viewport.readInput(new WheelEvent("wheel", { deltaY: 1000 }));
      viewport.scroll();
      expect(viewport.follow.value).toBe(false);
      atHistoryTail = true;
      viewport.readInput(new WheelEvent("wheel", { deltaY: 1000 }));
      viewport.scroll();
      expect(viewport.follow.value).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });
  it.each([
    "horizontal-wheel",
    "vertical-wheel",
    "horizontal-touch",
    "vertical-touch",
    "outer-wheel",
    "outer-touch",
    "outer-keyboard",
  ])(
    "does not let a %s gesture re-arm follow through an unrelated owned outer adjustment",
    async (kind) => {
      const container = document.createElement("div");
      const canvas = document.createElement("div");
      const turn = document.createElement("article");
      const nested = document.createElement("pre");
      turn.dataset.anchorTurnId = "selected";
      nested.style.overflow = "auto";
      turn.append(nested);
      canvas.append(turn);
      container.append(canvas);
      document.body.append(container);
      let top = 0;
      let position = 140;
      Object.defineProperty(container, "scrollTop", {
        get: () => position,
        set: (value: number) => {
          position = Math.max(0, Math.min(200, value));
        },
      });
      container.getBoundingClientRect = () => rectangle(top, 800);
      canvas.getBoundingClientRect = () => rectangle(top - container.scrollTop, 1000);
      turn.getBoundingClientRect = () => rectangle(top - container.scrollTop, 1000);
      vi.spyOn(container, "clientHeight", "get").mockReturnValue(800);
      vi.spyOn(container, "scrollHeight", "get").mockReturnValue(1000);
      vi.spyOn(nested, "clientHeight", "get").mockReturnValue(100);
      vi.spyOn(nested, "scrollHeight", "get").mockReturnValue(600);
      vi.spyOn(nested, "clientWidth", "get").mockReturnValue(100);
      vi.spyOn(nested, "scrollWidth", "get").mockReturnValue(600);
      nested.scrollTop = 40;
      nested.scrollLeft = 40;
      let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
      const wrapper = await mountSuspended({
        setup() {
          viewport = useMeasuredConversationViewport({
            keys: () => ["selected"],
            surface: ref(container),
            canvas: ref(canvas),
            storageKey: `nested-owned-${kind}`,
            followEnabled: () => true,
            canFollow: () => true,
          });
          return () => h("span");
        },
      });
      const listener = (event: Event) => viewport.readInput(event);
      for (const event of ["wheel", "touchstart", "touchmove", "keydown"]) {
        container.addEventListener(event, listener);
      }
      try {
        container.scrollTop = 140;
        viewport.scroll();
        const owner = viewport.beginNavigation();
        const horizontal = kind.startsWith("horizontal");
        const target = kind.startsWith("outer") ? container : nested;
        if (kind.endsWith("wheel")) {
          target.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              deltaX: horizontal ? 20 : 0,
              deltaY: horizontal ? 0 : 20,
            }),
          );
        } else if (kind.endsWith("keyboard")) {
          target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
        } else {
          const first = new Touch({ identifier: 1, target, clientX: 100, clientY: 100 });
          target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [first] }));
          const moved = new Touch({
            identifier: 1,
            target,
            clientX: horizontal ? 80 : 100,
            clientY: horizontal ? 100 : 80,
          });
          target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [moved] }));
        }
        expect(owner.isCurrent()).toBe(false);
        expect(viewport.follow.value).toBe(false);
        expect(container.scrollTop).toBe(140);
        viewport.capture();
        top = 10;
        await viewport.settle();
        expect(container.scrollTop).toBe(150);
        viewport.scroll();
        expect(viewport.follow.value).toBe(false);
        await viewport.settle();
        expect(container.scrollTop).toBe(150);
      } finally {
        wrapper.unmount();
        container.remove();
      }
    },
  );
  it.each([
    ["wheel", true],
    ["touch-end", true],
    ["keyboard", true],
    ["nested-boundary", true],
    ["nested-contained", false],
    ["horizontal", false],
  ] as const)(
    "qualifies actual outer movement observed before its scroll event for %s input",
    async (kind, expectedFollow) => {
      const container = document.createElement("div");
      const canvas = document.createElement("div");
      const nested = document.createElement("pre");
      nested.style.overflowY = "auto";
      nested.style.overscrollBehaviorY = kind === "nested-contained" ? "contain" : "auto";
      canvas.append(nested);
      container.append(canvas);
      document.body.append(container);
      container.getBoundingClientRect = () => rectangle(0, 800);
      canvas.getBoundingClientRect = () => rectangle(-container.scrollTop, 1000);
      vi.spyOn(container, "clientHeight", "get").mockReturnValue(800);
      vi.spyOn(container, "scrollHeight", "get").mockReturnValue(1000);
      vi.spyOn(nested, "clientHeight", "get").mockReturnValue(100);
      vi.spyOn(nested, "scrollHeight", "get").mockReturnValue(600);
      nested.scrollTop = 500;
      let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
      const wrapper = await mountSuspended({
        setup() {
          viewport = useMeasuredConversationViewport({
            keys: () => ["selected"],
            surface: ref(container),
            canvas: ref(canvas),
            storageKey: `outer-qualified-${kind}`,
            followEnabled: () => true,
            canFollow: () => true,
          });
          return () => h("span");
        },
      });
      for (const event of ["wheel", "keydown", "touchstart", "touchmove", "touchend"]) {
        container.addEventListener(event, (input) => viewport.readInput(input));
      }
      try {
        container.scrollTop = 100;
        viewport.scroll();
        const target = kind.startsWith("nested") ? nested : container;
        if (kind === "touch-end") {
          target.dispatchEvent(
            new TouchEvent("touchstart", {
              bubbles: true,
              touches: [new Touch({ identifier: 1, target, clientX: 100, clientY: 100 })],
            }),
          );
          target.dispatchEvent(
            new TouchEvent("touchmove", {
              bubbles: true,
              touches: [new Touch({ identifier: 1, target, clientX: 100, clientY: 40 })],
            }),
          );
          target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [] }));
        } else if (kind === "keyboard") {
          target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageDown" }));
        } else {
          target.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              deltaX: kind === "horizontal" ? 60 : 0,
              deltaY: kind === "horizontal" ? 0 : 60,
            }),
          );
        }
        expect(viewport.follow.value).toBe(false);
        container.scrollTop = 160;
        viewport.capture();
        viewport.scroll();
        expect(viewport.follow.value).toBe(expectedFollow);
      } finally {
        wrapper.unmount();
        container.remove();
      }
    },
  );
  it.each([
    "recover",
    "surface",
    "wheel",
    "pointer",
    "source",
    "eviction",
    "entry-eviction",
    "entry-unmount",
    "entry-unknown",
    "dispose",
    "latest",
  ] as const)(
    "qualifies a pending clamped restore through repeated capture and %s completion",
    async (ending) => {
      const container = document.createElement("div");
      const canvas = document.createElement("div");
      const turn = document.createElement("article");
      const entry = document.createElement("article");
      turn.dataset.anchorTurnId = "selected";
      turn.dataset.anchorSource = "source:epoch-A";
      entry.dataset.anchorEntry = "reading-entry";
      turn.append(entry);
      canvas.append(turn);
      container.append(canvas);
      let height = 1600;
      let position = 0;
      let surfaceTop = 0;
      let entryOffset = 300;
      let entryRetained: boolean | undefined = true;
      let source = "source:epoch-A";
      const keys = ref(["selected"]);
      Object.defineProperty(container, "scrollTop", {
        get: () => position,
        set: (value: number) => {
          position = Math.max(0, Math.min(height - 800, value));
        },
      });
      container.getBoundingClientRect = () => rectangle(surfaceTop, 800);
      canvas.getBoundingClientRect = () => rectangle(surfaceTop - container.scrollTop, height);
      turn.getBoundingClientRect = () => rectangle(surfaceTop - container.scrollTop, height);
      entry.getBoundingClientRect = () =>
        rectangle(surfaceTop + entryOffset - container.scrollTop, 1000);
      vi.spyOn(container, "clientHeight", "get").mockReturnValue(800);
      vi.spyOn(container, "scrollHeight", "get").mockImplementation(() => height);
      let viewport!: ReturnType<typeof useMeasuredConversationViewport>;
      const wrapper = await mountSuspended({
        setup() {
          viewport = useMeasuredConversationViewport({
            keys: () => keys.value,
            surface: ref(container),
            canvas: ref(canvas),
            storageKey: `deferred-clamp-${ending}`,
            followEnabled: () => true,
            sourceIdentity: (key) => (keys.value.includes(key) ? source : null),
            entryRetained: () => entryRetained,
          });
          return () => h("span");
        },
      });
      let disposed = false;
      try {
        container.scrollTop = 600;
        viewport.scroll();
        const before = entry.getBoundingClientRect().top;
        viewport.capture();
        height = 1200;
        container.scrollTop = container.scrollTop;
        await viewport.settle();
        expect(container.scrollTop).toBe(400);
        viewport.capture();
        await viewport.settle();
        viewport.capture();
        let expectedPosition = 600;
        let expectedEntryTop = before;
        if (ending === "surface") {
          surfaceTop = 40;
          expectedPosition = 640;
        } else if (ending === "wheel") {
          viewport.readInput(new WheelEvent("wheel", { deltaY: -120 }));
          container.scrollTop = 300;
          viewport.scroll();
          expectedPosition = 300;
          expectedEntryTop = 0;
        } else if (ending === "pointer") {
          viewport.readInput(new PointerEvent("pointerdown"));
          expectedPosition = 400;
          expectedEntryTop = -100;
        } else if (ending === "source") {
          source = "source:epoch-B";
          turn.dataset.anchorSource = source;
          viewport.capture();
          expectedPosition = 400;
          expectedEntryTop = -100;
        } else if (ending === "eviction") {
          keys.value = [];
          turn.remove();
          viewport.capture();
          expectedPosition = 400;
          expectedEntryTop = -100;
        } else if (ending === "entry-eviction") {
          entryRetained = false;
          entry.remove();
          viewport.capture();
          expectedPosition = 400;
          expectedEntryTop = -100;
        } else if (ending === "entry-unmount" || ending === "entry-unknown") {
          entryRetained = ending === "entry-unknown" ? undefined : true;
          entry.remove();
          await viewport.settle();
          height = 1600;
          await viewport.settle();
          viewport.capture();
          entryOffset = 400;
          turn.append(entry);
          expectedPosition = 700;
        } else if (ending === "dispose") {
          wrapper.unmount();
          disposed = true;
          expectedPosition = 400;
          expectedEntryTop = -100;
        } else if (ending === "latest") {
          await viewport.latest();
          expectedPosition = 800;
          expectedEntryTop = -500;
        }
        height = 1600;
        await viewport.settle();
        expect(container.scrollTop).toBe(expectedPosition);
        expect(entry.getBoundingClientRect().top).toBe(expectedEntryTop);
        expect(viewport.follow.value).toBe(ending === "latest");
      } finally {
        if (!disposed) {
          wrapper.unmount();
        }
      }
    },
  );
  it.each(["turn", "virtual"])(
    "reports an unmounted entry separately from physical clamping through a %s fallback",
    async (mount) => {
      const container = document.createElement("div");
      container.scrollTop = 100;
      container.getBoundingClientRect = () => rectangle(0, 800);
      const turn = document.createElement("article");
      turn.dataset.anchorTurnId = "turn";
      turn.getBoundingClientRect = () => rectangle(200 - container.scrollTop, 1000);
      if (mount === "turn") {
        container.append(turn);
      }
      const anchoring = useScrollAnchoring(ref(container), () => 200);
      const result = await anchoring.restore({
        turnId: "turn",
        top: -100,
        entry: { key: "retained-entry", top: -40 },
      });
      expect(container.scrollTop).toBe(300);
      expect(result).toBe("unmounted");
    },
  );
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
