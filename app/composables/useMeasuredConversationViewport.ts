import { elementScroll, useVirtualizer, type VirtualizerOptions } from "@tanstack/vue-virtual";
import type { Ref } from "vue";

import type { ScrollNavigationOwner } from "#shared/timeline/scrollAnchoring.ts";
import { installConversationScrollPolicy } from "#shared/timeline/virtualizer.ts";
import type { ScrollAnchorSnapshot } from "~/composables/useScrollAnchoring.ts";

export function useMeasuredConversationViewport(options: {
  keys: () => readonly string[];
  surface: Ref<HTMLElement | null>;
  canvas: Ref<HTMLElement | null>;
  storageKey: string;
  followEnabled: () => boolean;
  canFollow?: () => boolean;
  sourceIdentity?: (key: string) => string | null;
  entryRetained?: (key: string, entry: string) => boolean | undefined;
}) {
  const origin = ref(0);
  const follow = ref(true);
  const latestAvailable = ref(false);
  const positions = useState<Record<string, ScrollAnchorSnapshot>>(
    "conversation-positions",
    () => ({}),
  );
  const restoredPosition = positions.value[options.storageKey] ?? null;
  let writesReady = false;
  let expectedScrollTop = options.surface.value?.scrollTop ?? null;
  const scrollTo: VirtualizerOptions<HTMLElement, Element>["scrollToFn"] = (
    offset,
    settings,
    instance,
  ) => {
    const container = instance.scrollElement;
    if (container && writesReady && (disposed || observeUnowned(container))) {
      return;
    }
    if (writesReady) {
      readerInput = null;
    }
    elementScroll(offset, settings, instance);
    if (container) {
      expectedScrollTop = container.scrollTop;
    }
  };
  const virtualizer = useVirtualizer(
    computed(() => ({
      count: options.keys().length,
      getItemKey: (index: number) => options.keys()[index] ?? index,
      getScrollElement: () => options.surface.value,
      estimateSize: () => 520,
      initialRect: { width: 800, height: 800 },
      overscan: 3,
      scrollMargin: origin.value,
      scrollToFn: scrollTo,
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
    options.sourceIdentity,
    writeScroll,
  );
  let observer: ResizeObserver | null = null;
  const measuredElements = new Set<HTMLElement>();
  let snapshot: ScrollAnchorSnapshot | null = null;
  let snapshotSurface: { top: number; width: number } | undefined;
  let restorePending = false;
  let rememberedSurface: { top: number; width: number } | undefined;
  let scheduled = false;
  let settleQueued = false;
  let disposed = false;
  let navigation = 0;
  let readerInput: { top: number; direction: number; observedTop: number | null } | null = null;
  let touch: { identifier: number; x: number; y: number } | null = null;
  let navigating = false;
  writesReady = true;
  function surfaceGeometry() {
    const bounds = options.surface.value?.getBoundingClientRect();
    return bounds ? { top: bounds.top, width: bounds.width } : undefined;
  }
  function remember() {
    releaseInvalidRestore();
    if (restorePending) {
      return;
    }
    if (!anchoring.active) {
      anchoring.remember(anchoring.snapshot);
      rememberedSurface = surfaceGeometry();
    }
  }
  function releaseInvalidRestore() {
    if (
      restorePending &&
      (!snapshot ||
        disposed ||
        (snapshot.inputVersion !== undefined && snapshot.inputVersion !== anchoring.inputVersion) ||
        !options.keys().includes(snapshot.turnId) ||
        (snapshot.entry &&
          options.entryRetained?.(snapshot.turnId, snapshot.entry.key) === false) ||
        (snapshot.source &&
          options.sourceIdentity &&
          snapshot.source !== options.sourceIdentity(snapshot.turnId)))
    ) {
      restorePending = false;
      snapshot = null;
      snapshotSurface = undefined;
      anchoring.cancel();
      rememberedSurface = undefined;
    }
  }
  function observeUnowned(container: Element): boolean {
    const current = container.scrollTop;
    const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
    const clamped =
      expectedScrollTop !== null &&
      expectedScrollTop > maximum &&
      Math.abs(current - maximum) <= 0.5;
    if (expectedScrollTop === null || Math.abs(current - expectedScrollTop) <= 0.5 || clamped) {
      expectedScrollTop = current;
      return false;
    }
    expectedScrollTop = current;
    if (
      readerInput &&
      (readerInput.direction === 0 || (current - readerInput.top) * readerInput.direction > 0)
    ) {
      readerInput.observedTop = current;
    }
    navigation++;
    navigating = false;
    follow.value = false;
    restorePending = false;
    snapshot = null;
    snapshotSurface = undefined;
    anchoring.cancel();
    remember();
    return true;
  }
  function writeScroll(container: HTMLElement, top: number) {
    if (disposed || observeUnowned(container)) {
      return;
    }
    readerInput = null;
    container.scrollTop = top;
    expectedScrollTop = container.scrollTop;
  }
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
    if (options.surface.value) {
      observeUnowned(options.surface.value);
    }
    releaseInvalidRestore();
    if (snapshot === null) {
      snapshot = anchoring.capture(anchoring.snapshot);
      snapshotSurface = surfaceGeometry();
    }
  }
  async function settle() {
    if (options.surface.value) {
      observeUnowned(options.surface.value);
    }
    releaseInvalidRestore();
    if (disposed || navigating) {
      return;
    }
    if (scheduled) {
      settleQueued = true;
      return;
    }
    scheduled = true;
    const version = navigation;
    try {
      await nextTick();
      const container = options.surface.value;
      const canvas = options.canvas.value;
      if (!container || !canvas || version !== navigation || disposed) {
        return;
      }
      updateOrigin();
      await nextTick();
      if (version !== navigation || disposed) {
        return;
      }
      if (follow.value && options.followEnabled()) {
        writeScroll(container, container.scrollHeight);
      } else {
        const desired = snapshot ?? anchoring.snapshot;
        const desiredSurface = snapshot ? snapshotSurface : rememberedSurface;
        const result = await anchoring.restore(desired, desiredSurface);
        if (version === navigation && !disposed) {
          restorePending = result === "clamped" || result === "unmounted";
          if (restorePending) {
            snapshot = desired;
            snapshotSurface = desiredSurface;
          }
        }
      }
      if (version === navigation && !disposed) {
        remember();
      }
    } finally {
      if (version === navigation && !restorePending) {
        snapshot = null;
        snapshotSurface = undefined;
      }
      scheduled = false;
      if (settleQueued) {
        settleQueued = false;
        await settle();
      }
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
  function inputDirection(event: Event): number {
    if (event instanceof WheelEvent) {
      return !event.ctrlKey && !event.shiftKey && Math.abs(event.deltaY) >= Math.abs(event.deltaX)
        ? Math.sign(event.deltaY)
        : 0;
    }
    if (event instanceof KeyboardEvent) {
      return ["ArrowDown", "PageDown", "End"].includes(event.key) ||
        (event.key === " " && !event.shiftKey)
        ? 1
        : ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)
          ? -1
          : 0;
    }
    if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      const previous = touch;
      touch = point ? { identifier: point.identifier, x: point.clientX, y: point.clientY } : null;
      if (
        event.type !== "touchmove" ||
        !point ||
        !previous ||
        previous.identifier !== point.identifier
      ) {
        return 0;
      }
      const deltaX = previous.x - point.clientX;
      const deltaY = previous.y - point.clientY;
      return Math.abs(deltaY) >= Math.abs(deltaX) ? Math.sign(deltaY) : 0;
    }
    return 0;
  }
  function reachesOuterScroll(event: Event, direction: number, container: HTMLElement): boolean {
    if (direction === 0 || event.defaultPrevented) {
      return false;
    }
    let scrollTarget = event.target instanceof Element ? event.target : container;
    if (
      event instanceof KeyboardEvent &&
      scrollTarget.closest("input,select,textarea,[contenteditable=true]")
    ) {
      return false;
    }
    while (scrollTarget !== container) {
      const style = getComputedStyle(scrollTarget);
      if (["auto", "scroll", "overlay"].includes(style.overflowY)) {
        const maximum = scrollTarget.scrollHeight - scrollTarget.clientHeight;
        const consumes =
          maximum > 0 &&
          (direction > 0 ? scrollTarget.scrollTop < maximum : scrollTarget.scrollTop > 0);
        if (consumes || ["contain", "none"].includes(style.overscrollBehaviorY)) {
          return false;
        }
      }
      if (!scrollTarget.parentElement) {
        return false;
      }
      scrollTarget = scrollTarget.parentElement;
    }
    return true;
  }
  function readInput(event: Event) {
    if (event.type === "touchend" || event.type === "touchcancel") {
      touch = null;
      if (event.type === "touchcancel") {
        readerInput = null;
      }
      return false;
    }
    const controlActivation =
      event instanceof KeyboardEvent &&
      [" ", "Enter"].includes(event.key) &&
      event.target instanceof Element &&
      event.target.closest(
        "a[href],button,input,select,summary,textarea,[role=button],[contenteditable=true]",
      ) !== null;
    if (
      event instanceof KeyboardEvent &&
      !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
      !controlActivation
    ) {
      return false;
    }
    navigation++;
    const container = options.surface.value;
    const bounds =
      event instanceof PointerEvent && event.target === container
        ? container?.getBoundingClientRect()
        : undefined;
    const scrollbar =
      event instanceof PointerEvent &&
      container !== null &&
      bounds !== undefined &&
      event.clientX >= bounds.left + container.clientLeft + container.clientWidth &&
      event.clientX < bounds.right;
    const direction = inputDirection(event);
    const outerInput =
      container !== null &&
      (scrollbar || (!controlActivation && reachesOuterScroll(event, direction, container)));
    readerInput = outerInput ? { top: container.scrollTop, direction, observedTop: null } : null;
    navigating = false;
    restorePending = false;
    follow.value =
      outerInput &&
      (scrollbar || direction > 0) &&
      options.canFollow?.() !== false &&
      container.clientHeight > 0 &&
      container.scrollHeight >= container.clientHeight &&
      container.scrollTop >= Math.max(0, container.scrollHeight - container.clientHeight) - 0.5;
    if (follow.value) {
      latestAvailable.value = false;
    }
    snapshot = null;
    snapshotSurface = undefined;
    expectedScrollTop = container?.scrollTop ?? null;
    anchoring.cancel();
    remember();
    return true;
  }
  function scroll() {
    const container = options.surface.value;
    if (!container || disposed) {
      return false;
    }
    const unowned = observeUnowned(container);
    const readerMoved = readerInput?.observedTop === container.scrollTop;
    readerInput = null;
    if (!unowned && !readerMoved && (navigating || scheduled)) {
      return false;
    }
    if (readerMoved) {
      follow.value =
        options.canFollow?.() !== false &&
        container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    }
    if (follow.value) {
      latestAvailable.value = false;
    }
    remember();
    return unowned;
  }
  function beginNavigation(): ScrollNavigationOwner {
    const version = ++navigation;
    readerInput = null;
    touch = null;
    restorePending = false;
    navigating = true;
    follow.value = false;
    snapshot = null;
    snapshotSurface = undefined;
    rememberedSurface = undefined;
    expectedScrollTop = options.surface.value?.scrollTop ?? null;
    anchoring.cancel();
    return { isCurrent: () => version === navigation && !disposed };
  }
  function finishNavigation(owner: ScrollNavigationOwner) {
    if (owner.isCurrent()) {
      navigating = false;
      remember();
    }
  }
  // oxlint-disable no-await-in-loop -- Each measured frame depends on the preceding layout and reader input
  async function target(
    key: string,
    top = 0,
    owner = beginNavigation(),
    restored?: ScrollAnchorSnapshot,
  ) {
    if (!owner.isCurrent()) {
      return;
    }
    const desired: ScrollAnchorSnapshot = {
      ...restored,
      turnId: key,
      top,
      inputVersion: anchoring.inputVersion,
    };
    await nextTick();
    if (!owner.isCurrent()) {
      return;
    }
    if (
      desired.source &&
      options.sourceIdentity &&
      desired.source !== options.sourceIdentity(key)
    ) {
      finishNavigation(owner);
      return;
    }
    updateOrigin();
    const index = options.keys().indexOf(key);
    if (index < 0) {
      navigating = false;
      return;
    }
    virtualizer.value.getTotalSize();
    const start = virtualizer.value.measurementsCache[index]?.start;
    if (start !== undefined && options.surface.value) {
      writeScroll(options.surface.value, Math.max(0, start - top));
    }
    for (let frame = 0; frame < 4; frame++) {
      await nextTick();
      if (!owner.isCurrent()) {
        return;
      }
      await anchoring.restore(desired);
      if (!owner.isCurrent()) {
        return;
      }
    }
    navigating = false;
    snapshot = desired;
    snapshotSurface = surfaceGeometry();
    await settle();
  }
  async function latest(owner = beginNavigation()) {
    if (!owner.isCurrent()) {
      return;
    }
    follow.value = true;
    restorePending = false;
    latestAvailable.value = false;
    snapshot = null;
    snapshotSurface = undefined;
    for (let frame = 0; frame < 4; frame++) {
      await nextTick();
      if (!owner.isCurrent()) {
        return;
      }
      const container = options.surface.value;
      if (container) {
        writeScroll(container, container.scrollHeight);
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!owner.isCurrent()) {
        return;
      }
    }
    navigating = false;
    remember();
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
    const position = anchoring.capture(anchoring.snapshot);
    if (position) {
      positions.value = Object.fromEntries([
        ...Object.entries(positions.value)
          .filter(([key]) => key !== options.storageKey)
          .slice(-31),
        [options.storageKey, { ...position, inputVersion: undefined }],
      ]);
    }
    disposed = true;
    restorePending = false;
    snapshot = null;
    snapshotSurface = undefined;
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
    beginNavigation,
    finishNavigation,
    follow,
    latestAvailable,
    restoredPosition,
  };
}
