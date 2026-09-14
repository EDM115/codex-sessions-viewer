import type { Virtualizer } from "@tanstack/vue-virtual";

import { shouldAdjustForMeasuredRow } from "./scrollAnchoring.ts";

export function installConversationScrollPolicy(
  instance: Virtualizer<HTMLElement, Element>,
  canvasOrigin: () => number = () => 0,
): void {
  // This is an instance property in TanStack Virtual, not a VirtualizerOptions field.
  instance.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, virtualizer) =>
    shouldAdjustForMeasuredRow(
      item,
      virtualizer.scrollOffset === null ? null : virtualizer.scrollOffset - canvasOrigin(),
    );
}
