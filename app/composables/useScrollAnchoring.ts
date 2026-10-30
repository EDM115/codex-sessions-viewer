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

  function capture(): ScrollAnchorSnapshot | null {
    const container = scrollElement.value;
    if (container === null) {
      return null;
    }
    // Newly mounted rows can temporarily overlap: their DOM has its real height
    // while transforms still use estimates. Keep identity and offset in the
    // virtualizer's coordinate model until its measurements settle.
    const virtualSnapshot = fallbackSnapshot();
    const containerTop = container.getBoundingClientRect().top;
    const element = virtualSnapshot
      ? turnElements().find((candidate) => turnKey(candidate) === virtualSnapshot.turnId)
      : turnElements().find((candidate) => candidate.getBoundingClientRect().bottom > containerTop);
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
    const entry = entryElements(element).find((candidate) => {
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

  function remember(): void {
    if (activeTransaction === null) {
      remembered = capture();
    }
  }

  async function restore(snapshot: ScrollAnchorSnapshot | null = remembered): Promise<void> {
    const container = scrollElement.value;
    if (
      container === null ||
      snapshot === null ||
      (snapshot.inputVersion !== undefined && snapshot.inputVersion !== inputVersion)
    ) {
      return;
    }
    const version = inputVersion;
    const currentTransaction = ++transaction;
    remembered = snapshot;
    activeTransaction = currentTransaction;
    const valid = () =>
      version === inputVersion &&
      currentTransaction === transaction &&
      scrollElement.value === container;
    const apply = () => {
      if (!valid()) {
        return;
      }
      const element = turnElements().find((candidate) => turnKey(candidate) === snapshot.turnId);
      if (
        snapshot.source &&
        snapshot.source !== (sourceIdentity(snapshot.turnId) ?? element?.dataset["anchorSource"])
      ) {
        return;
      }
      if (element !== undefined) {
        const entry =
          snapshot.entry &&
          entryElements(element).find((candidate) => entryKey(candidate) === snapshot.entry!.key);
        const delta = scrollAnchorAdjustment(entry && snapshot.entry ? snapshot.entry : snapshot, {
          top:
            (entry || element).getBoundingClientRect().top - container.getBoundingClientRect().top,
        });
        if (Math.abs(delta) > 0.5) {
          container.scrollTop += delta;
        }
      } else {
        // The virtual range may have moved after a prepend or a width invalidation.
        // Resolve the stable ID in the new measurements before waiting for its DOM.
        const start = virtualStart(snapshot.turnId);
        if (start !== null) {
          container.scrollTop = Math.max(0, start - snapshot.top);
        }
      }
    };
    try {
      await nextTick();
      apply();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await nextTick();
      apply();
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
