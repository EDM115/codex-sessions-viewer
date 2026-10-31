import type { Ref } from "vue";

import {
  scrollAnchorAdjustment,
  type ScrollAnchorPosition,
} from "#shared/timeline/scrollAnchoring.ts";

export { scrollAnchorAdjustment } from "#shared/timeline/scrollAnchoring.ts";

export interface ScrollAnchorSnapshot extends ScrollAnchorPosition {
  turnId: string;
  inputVersion?: number;
  source?: string;
  entry?: { key: string; top: number };
}

export function useScrollAnchoring(
  scrollElement: Ref<HTMLElement | null>,
  virtualStart: (turnId: string) => number | null = () => null,
  virtualAnchor: () => ScrollAnchorSnapshot | null = () => null,
  sourceIdentity: (turnId: string) => string | null = () => null,
  writeScroll: (container: HTMLElement, top: number) => void = (container, top) => {
    container.scrollTop = top;
  },
) {
  let inputVersion = 0;
  let remembered: ScrollAnchorSnapshot | null = null;
  let activeTransaction: number | null = null;
  let transaction = 0;

  function turnElements(): HTMLElement[] {
    return scrollElement.value === null
      ? []
      : [
          ...scrollElement.value.querySelectorAll<HTMLElement>(
            ".conversation-turn[data-turn-id], [data-anchor-turn-id]",
          ),
        ];
  }

  function capture(preferred?: ScrollAnchorSnapshot | null): ScrollAnchorSnapshot | null {
    const container = scrollElement.value;
    if (container === null) {
      return null;
    }
    // Newly mounted rows can temporarily overlap: their DOM has its real height
    // while transforms still use estimates. Keep identity and offset in the
    // virtualizer's coordinate model until its measurements settle.
    const containerTop = container.getBoundingClientRect().top;
    const elements = turnElements();
    const preferredElement = preferred
      ? elements.find((candidate) => turnKey(candidate) === preferred.turnId)
      : undefined;
    const preferredStart = preferred ? virtualStart(preferred.turnId) : null;
    const preserveChoice =
      preferred &&
      (preferred.inputVersion === undefined || preferred.inputVersion === inputVersion) &&
      (preferredElement !== undefined || preferredStart !== null) &&
      (!preferred.source ||
        preferred.source ===
          (sourceIdentity(preferred.turnId) ?? preferredElement?.dataset["anchorSource"]));
    const virtualSnapshot = preserveChoice
      ? {
          turnId: preferred.turnId,
          top:
            preferredStart !== null
              ? preferredStart - container.scrollTop
              : preferredElement!.getBoundingClientRect().top - containerTop,
          inputVersion,
        }
      : fallbackSnapshot();
    const element = virtualSnapshot
      ? elements.find((candidate) => turnKey(candidate) === virtualSnapshot.turnId)
      : elements.find((candidate) => candidate.getBoundingClientRect().bottom > containerTop);
    const turnId = element?.dataset["turnId"] ?? element?.dataset["anchorTurnId"];
    const snapshot =
      virtualSnapshot ??
      (element && turnId
        ? { turnId, top: element.getBoundingClientRect().top - containerTop, inputVersion }
        : null);
    if (!snapshot) {
      return null;
    }
    const source = sourceIdentity(snapshot.turnId) ?? element?.dataset["anchorSource"];
    const entry = preserveChoice
      ? entryElements(element).find((candidate) => entryKey(candidate) === preferred.entry?.key)
      : entryElements(element).find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.height > 0 && rect.bottom > containerTop && rect.top <= containerTop;
        });
    return {
      ...snapshot,
      ...(source ? { source } : {}),
      ...(entry
        ? {
            entry: { key: entryKey(entry)!, top: entry.getBoundingClientRect().top - containerTop },
          }
        : {}),
    };
  }

  const turnKey = (element: HTMLElement) =>
    element.dataset["turnId"] ?? element.dataset["anchorTurnId"];
  const entryKey = (element: HTMLElement) =>
    element.dataset["anchorEntry"] ??
    (element.dataset["messageId"]
      ? `message:${element.dataset["messageId"]}`
      : element.dataset["entryId"]
        ? `activity:${element.dataset["entryId"]}`
        : undefined);
  function entryElements(element?: HTMLElement) {
    return element
      ? [
          ...element.querySelectorAll<HTMLElement>(
            "[data-anchor-entry], [data-message-id], [data-entry-id]",
          ),
        ]
      : [];
  }

  function fallbackSnapshot(): ScrollAnchorSnapshot | null {
    const snapshot = virtualAnchor();
    return snapshot === null ? null : { ...snapshot, inputVersion };
  }

  function cancel(): void {
    inputVersion += 1;
    remembered = null;
    activeTransaction = null;
  }

  function remember(preferred?: ScrollAnchorSnapshot | null): void {
    if (activeTransaction === null) {
      remembered = capture(preferred);
    }
  }

  async function restore(
    snapshot: ScrollAnchorSnapshot | null = remembered,
    surface?: { top: number; width: number },
  ): Promise<"settled" | "clamped" | "unmounted" | "cancelled"> {
    const container = scrollElement.value;
    if (
      container === null ||
      snapshot === null ||
      (snapshot.inputVersion !== undefined && snapshot.inputVersion !== inputVersion)
    ) {
      return "cancelled";
    }
    const version = inputVersion;
    const currentTransaction = ++transaction;
    remembered = snapshot;
    activeTransaction = currentTransaction;
    const valid = () =>
      version === inputVersion &&
      currentTransaction === transaction &&
      scrollElement.value === container;
    const writePosition = (desired: number): "settled" | "clamped" | "cancelled" => {
      writeScroll(container, Math.max(0, desired));
      if (!valid()) {
        return "cancelled";
      }
      if (Math.abs(container.scrollTop - desired) <= 0.5) {
        return "settled";
      }
      const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
      return (desired < 0 && container.scrollTop <= 0.5) ||
        (desired > maximum && Math.abs(container.scrollTop - maximum) <= 0.5)
        ? "clamped"
        : "cancelled";
    };
    const apply = (): "settled" | "clamped" | "unmounted" | "cancelled" => {
      if (!valid()) {
        return "cancelled";
      }
      const bounds = container.getBoundingClientRect();
      const surfaceShift = surface?.width === bounds.width ? surface.top - bounds.top : 0;
      const element = turnElements().find((candidate) => turnKey(candidate) === snapshot.turnId);
      if (
        snapshot.source &&
        snapshot.source !== (sourceIdentity(snapshot.turnId) ?? element?.dataset["anchorSource"])
      ) {
        return "cancelled";
      }
      if (element !== undefined) {
        const entry =
          snapshot.entry &&
          entryElements(element).find((candidate) => entryKey(candidate) === snapshot.entry!.key);
        const previous = entry && snapshot.entry ? snapshot.entry : snapshot;
        const delta = scrollAnchorAdjustment(
          { top: previous.top + surfaceShift },
          { top: (entry || element).getBoundingClientRect().top - bounds.top },
        );
        if (Math.abs(delta) > 0.5) {
          const result = writePosition(container.scrollTop + delta);
          return result === "settled" && snapshot.entry && !entry ? "unmounted" : result;
        }
        return snapshot.entry && !entry ? "unmounted" : "settled";
      } else {
        // The virtual range may have moved after a prepend or a width invalidation.
        // Resolve the stable ID in the new measurements before waiting for its DOM.
        const start = virtualStart(snapshot.turnId);
        if (start !== null) {
          const result = writePosition(start - snapshot.top - surfaceShift);
          return result === "settled" && snapshot.entry ? "unmounted" : result;
        }
        return "cancelled";
      }
    };
    try {
      await nextTick();
      const first = apply();
      if (first === "cancelled") {
        return first;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await nextTick();
      return apply();
    } finally {
      if (activeTransaction === currentTransaction) {
        activeTransaction = null;
      }
    }
  }

  async function preserve(operation: () => unknown): Promise<void> {
    const snapshot = capture();
    await operation();
    await restore(snapshot);
  }

  return {
    capture,
    preserve,
    restore,
    remember,
    cancel,
    get inputVersion() {
      return inputVersion;
    },
    get active() {
      return activeTransaction !== null;
    },
    get snapshot() {
      return remembered;
    },
  } as const;
}
