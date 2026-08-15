import { readonly, ref, toValue, type MaybeRefOrGetter } from "vue";

import { minimapDestinationIndex } from "#shared/timeline/turnMinimap.ts";
import type { TurnNavigatorItem } from "#shared/types/conversation.ts";

export {
  markerWidthForBucket,
  minimapDestinationIndex,
  minimapPreview,
} from "#shared/timeline/turnMinimap.ts";

export function useTurnMinimap(
  items: MaybeRefOrGetter<readonly TurnNavigatorItem[]>,
  initialTurnId: string | null = null,
) {
  const currentTurnId = ref(initialTurnId);

  function setCurrent(turnId: string | null): void {
    currentTurnId.value = turnId;
  }

  function move(key: string): TurnNavigatorItem | null {
    const available = toValue(items);
    const currentIndex = Math.max(
      0,
      available.findIndex(({ turnId }) => turnId === currentTurnId.value),
    );
    const destination = minimapDestinationIndex(key, currentIndex, available.length);
    if (destination === null) {
      return null;
    }
    const item = available[destination] ?? null;
    if (item !== null) {
      currentTurnId.value = item.turnId;
    }
    return item;
  }

  return { currentTurnId: readonly(currentTurnId), move, setCurrent } as const;
}
