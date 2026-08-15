import { nextTick, type Ref } from "vue";

import {
  scrollAnchorAdjustment,
  type ScrollAnchorPosition,
} from "#shared/timeline/scrollAnchoring.ts";

export { scrollAnchorAdjustment } from "#shared/timeline/scrollAnchoring.ts";

export interface ScrollAnchorSnapshot extends ScrollAnchorPosition {
  turnId: string;
}

export function useScrollAnchoring(
  scrollElement: Ref<HTMLElement | null>,
  measure: () => void = () => undefined,
) {
  function turnElements(): HTMLElement[] {
    return scrollElement.value === null
      ? []
      : [...scrollElement.value.querySelectorAll<HTMLElement>("[data-turn-id]")];
  }

  function capture(): ScrollAnchorSnapshot | null {
    const container = scrollElement.value;
    if (container === null) {
      return null;
    }
    const containerTop = container.getBoundingClientRect().top;
    const element = turnElements().find(
      (candidate) => candidate.getBoundingClientRect().bottom > containerTop,
    );
    const turnId = element?.dataset["turnId"];
    return element === undefined || turnId === undefined
      ? null
      : { turnId, top: element.getBoundingClientRect().top - containerTop };
  }

  async function restore(snapshot: ScrollAnchorSnapshot | null): Promise<void> {
    const container = scrollElement.value;
    if (container === null || snapshot === null) {
      return;
    }
    const anchor = snapshot;
    const scrollContainer = container;

    function applyAdjustment(): boolean {
      const element = turnElements().find(({ dataset }) => dataset["turnId"] === anchor.turnId);
      if (element === undefined) {
        return false;
      }
      const current = {
        top: element.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top,
      };
      scrollContainer.scrollTop += scrollAnchorAdjustment(anchor, current);
      return true;
    }

    async function settleAdjustment(remainingFrames: number): Promise<void> {
      await nextTick();
      applyAdjustment();
      if (remainingFrames > 0) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await settleAdjustment(remainingFrames - 1);
      }
    }

    await nextTick();
    measure();
    await settleAdjustment(3);
  }

  async function preserve(operation: () => unknown): Promise<void> {
    const snapshot = capture();
    await operation();
    await restore(snapshot);
  }

  return { capture, preserve, restore } as const;
}
