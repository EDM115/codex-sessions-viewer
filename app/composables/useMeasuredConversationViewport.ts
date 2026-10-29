import { useVirtualizer } from "@tanstack/vue-virtual";
import type { Ref } from "vue";

import { installConversationScrollPolicy } from "#shared/timeline/virtualizer.ts";
import type { ScrollAnchorSnapshot } from "~/composables/useScrollAnchoring.ts";

export function useMeasuredConversationViewport(options: {
  keys: () => readonly string[];
  surface: Ref<HTMLElement | null>;
  canvas: Ref<HTMLElement | null>;
  storageKey: string;
  followEnabled: () => boolean;
}) {
  const origin = ref(0);
  const follow = ref(true);
  const latestAvailable = ref(false);
  const positions = useState<Record<string, ScrollAnchorSnapshot>>(
    "conversation-positions",
    () => ({}),
  );
  const restoredPosition = positions.value[options.storageKey] ?? null;
  const virtualizer = useVirtualizer(
    computed(() => ({
      count: options.keys().length,
      getItemKey: (index: number) => options.keys()[index] ?? index,
      getScrollElement: () => options.surface.value,
      estimateSize: () => 520,
      initialRect: { width: 800, height: 800 },
      overscan: 3,
      scrollMargin: origin.value,
    })),
  );
  installConversationScrollPolicy(virtualizer.value);
  const rows = computed(() => virtualizer.value.getVirtualItems());
  const size = computed(() => virtualizer.value.getTotalSize());
  const anchoring = useScrollAnchoring(
    options.surface,
    (key) => {
      virtualizer.value.getTotalSize();
      return virtualizer.value.measurementsCache[options.keys().indexOf(key)]?.start ?? null;
    },
    () => {
      const container = options.surface.value;
      if (!container) {
        return null;
      }
      const row = virtualizer.value.getVirtualItemForOffset(container.scrollTop);
      const turnId = row ? options.keys()[row.index] : undefined;
      return row && turnId ? { turnId, top: row.start - container.scrollTop } : null;
    },
  );
  let observer: ResizeObserver | null = null;
  const measuredElements = new Set<HTMLElement>();
  let snapshot: ScrollAnchorSnapshot | null = null;
  let scheduled = false;
  let disposed = false;
  let navigation = 0;
  let readerInput = false;
  let navigating = false;
  function updateOrigin() {
    const container = options.surface.value;
    const canvas = options.canvas.value;
    if (container && canvas) {
      origin.value =
        canvas.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
    }
  }
  function capture() {
    snapshot ??= anchoring.capture();
  }
  async function settle() {
    if (scheduled || disposed || navigating) {
      return;
    }
    scheduled = true;
    try {
      await nextTick();
      const container = options.surface.value;
      const canvas = options.canvas.value;
      if (!container || !canvas) {
        return;
      }
      updateOrigin();
      await nextTick();
      if (follow.value && options.followEnabled()) {
        container.scrollTop = container.scrollHeight;
      } else {
        await anchoring.restore(snapshot ?? anchoring.snapshot);
      }
      anchoring.remember();
    } finally {
      snapshot = null;
      scheduled = false;
    }
  }
  function measure(element: unknown) {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    void nextTick().then(() => {
      if (element.isConnected) {
        virtualizer.value.measureElement(element);
        observer?.observe(element);
        measuredElements.add(element);
        for (const previous of measuredElements) {
          if (!previous.isConnected) {
            observer?.unobserve(previous);
            measuredElements.delete(previous);
          }
        }
      }
      return undefined;
    });
  }
  function readInput(event: Event) {
    if (
      event instanceof KeyboardEvent &&
      !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
    ) {
      return;
    }
    navigation++;
    readerInput = true;
    navigating = false;
    follow.value = false;
    snapshot = null;
    anchoring.cancel();
  }
  function scroll() {
    const container = options.surface.value;
    if (!container || navigating || scheduled) {
      return;
    }
    if (readerInput) {
      follow.value = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      readerInput = false;
    }
    if (follow.value) {
      latestAvailable.value = false;
    }
    anchoring.remember();
  }
  // oxlint-disable no-await-in-loop -- Each measured frame depends on the preceding layout and reader input
  async function target(key: string, top = 0) {
    const version = ++navigation;
    readerInput = false;
    navigating = true;
    follow.value = false;
    anchoring.cancel();
    await nextTick();
    updateOrigin();
    const index = options.keys().indexOf(key);
    if (index < 0) {
      navigating = false;
      return;
    }
    virtualizer.value.getTotalSize();
    const start = virtualizer.value.measurementsCache[index]?.start;
    if (start !== undefined && options.surface.value) {
      options.surface.value.scrollTop = Math.max(0, start - top);
    }
    for (let frame = 0; frame < 4; frame++) {
      await nextTick();
      if (version !== navigation || disposed) {
        return;
      }
      await anchoring.restore({ turnId: key, top });
    }
    navigating = false;
    snapshot = { turnId: key, top };
    await settle();
  }
  async function latest() {
    const version = ++navigation;
    readerInput = false;
    navigating = true;
    follow.value = true;
    latestAvailable.value = false;
    snapshot = null;
    anchoring.cancel();
    for (let frame = 0; frame < 4; frame++) {
      await nextTick();
      if (version !== navigation || disposed) {
        return;
      }
      const container = options.surface.value;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    navigating = false;
    anchoring.remember();
  }
  // oxlint-enable no-await-in-loop
  onMounted(() => {
    observer = new ResizeObserver(() => {
      void settle();
    });
    if (options.surface.value) {
      observer.observe(options.surface.value);
    }
    if (options.canvas.value) {
      observer.observe(options.canvas.value);
    }
  });
  onBeforeUnmount(() => {
    const position = anchoring.capture();
    if (position) {
      positions.value = Object.fromEntries([
        ...Object.entries(positions.value)
          .filter(([key]) => key !== options.storageKey)
          .slice(-31),
        [options.storageKey, { turnId: position.turnId, top: position.top }],
      ]);
    }
    disposed = true;
    observer?.disconnect();
    measuredElements.clear();
    anchoring.cancel();
  });
  return {
    rows,
    size,
    origin,
    measure,
    capture,
    settle,
    readInput,
    scroll,
    target,
    latest,
    follow,
    latestAvailable,
    restoredPosition,
  };
}
