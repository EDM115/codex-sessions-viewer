import { nextTick, type Ref } from "vue";

import {
  scrollAnchorAdjustment,
  type ScrollAnchorPosition,
} from "#shared/timeline/scrollAnchoring.ts";

export { scrollAnchorAdjustment } from "#shared/timeline/scrollAnchoring.ts";

export interface ScrollAnchorSnapshot extends ScrollAnchorPosition {
  turnId: string;
  inputVersion?: number;
}

export function useScrollAnchoring(
  scrollElement: Ref<HTMLElement | null>,
  virtualStart: (turnId: string) => number | null = () => null,
  virtualAnchor: () => ScrollAnchorSnapshot | null = () => null,
) {
  let inputVersion = 0;
  let remembered: ScrollAnchorSnapshot | null = null;
  let restoring = 0;

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
    if (virtualSnapshot !== null) {
      return virtualSnapshot;
    }
    const containerTop = container.getBoundingClientRect().top;
    const element = turnElements().find(
      (candidate) => candidate.getBoundingClientRect().bottom > containerTop,
    );
    const turnId = element?.dataset["turnId"] ?? element?.dataset["anchorTurnId"];
    return element === undefined || turnId === undefined
      ? fallbackSnapshot()
      : { turnId, top: element.getBoundingClientRect().top - containerTop, inputVersion };
  }

  function fallbackSnapshot(): ScrollAnchorSnapshot | null {
    const snapshot = virtualAnchor();
    return snapshot === null ? null : { ...snapshot, inputVersion };
  }

  function cancel(): void {
    inputVersion += 1;
    remembered = null;
  }

  function remember(): void {
    if (restoring === 0) {
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
    remembered = snapshot;
    restoring += 1;
    const valid = () => version === inputVersion && scrollElement.value === container;
    const apply = () => {
      if (!valid()) {
        return;
      }
      const element = turnElements().find(
        ({ dataset }) => (dataset["turnId"] ?? dataset["anchorTurnId"]) === snapshot.turnId,
      );
      if (element !== undefined) {
        const delta = scrollAnchorAdjustment(snapshot, {
          top: element.getBoundingClientRect().top - container.getBoundingClientRect().top,
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
      restoring -= 1;
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
    get snapshot() {
      return remembered;
    },
  } as const;
}
