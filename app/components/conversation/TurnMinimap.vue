<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import type { TurnNavigatorItem } from "#shared/types/conversation.ts";

import {
  markerWidthForBucket,
  minimapDestinationIndex,
  minimapPreview,
} from "../../composables/useTurnMinimap.ts";

const props = defineProps<{
  currentTurnId: string | null;
  items: TurnNavigatorItem[];
}>();

const emit = defineEmits<{
  select: [turnId: string];
}>();

const activeTurnId = ref<string | null>(null);
const buttons = ref<Array<HTMLButtonElement | null>>([]);
const activeItem = computed(() => props.items.find(({ turnId }) => turnId === activeTurnId.value));

function activate(item: TurnNavigatorItem): void {
  activeTurnId.value = item.turnId;
}

function select(item: TurnNavigatorItem): void {
  emit("select", item.turnId);
}

async function handleKeydown(event: KeyboardEvent, index: number): Promise<void> {
  const destination = minimapDestinationIndex(event.key, index, props.items.length);
  if (destination === null) {
    return;
  }
  event.preventDefault();
  const item = props.items[destination];
  if (item === undefined) {
    return;
  }
  activate(item);
  await nextTick();
  buttons.value[destination]?.focus();
  select(item);
}

watch(
  () => props.currentTurnId,
  async (turnId) => {
    if (turnId === null || activeTurnId.value !== null) {
      return;
    }
    await nextTick();
    const index = props.items.findIndex((item) => item.turnId === turnId);
    buttons.value[index]?.scrollIntoView({ block: "center" });
  },
  { immediate: true },
);
</script>

<template>
  <nav class="turn-minimap" aria-label="Conversation turns">
    <div class="turn-minimap__fade turn-minimap__fade--start" aria-hidden="true" />
    <div class="turn-minimap__scroll">
      <button
        v-for="(item, index) in items"
        :key="item.turnId"
        :ref="(element) => (buttons[index] = element as HTMLButtonElement | null)"
        type="button"
        class="turn-minimap__target"
        :class="item.turnId === currentTurnId || item.turnId === activeTurnId ? 'is-active' : null"
        :data-turn-id="item.turnId"
        :aria-label="`Turn ${item.index + 1}: ${minimapPreview(item).prompt || 'Prompt unavailable'}`"
        :aria-current="item.turnId === currentTurnId ? 'true' : undefined"
        :tabindex="
          item.turnId === currentTurnId || (currentTurnId === null && index === 0) ? 0 : -1
        "
        @click="select(item)"
        @focus="activate(item)"
        @blur="activeTurnId = null"
        @pointerenter="activate(item)"
        @pointerleave="activeTurnId = null"
        @keydown="handleKeydown($event, index)"
      >
        <span
          class="turn-minimap__marker"
          :style="{ width: `${markerWidthForBucket(item.proseLengthBucket)}px` }"
          aria-hidden="true"
        />
      </button>
    </div>
    <div class="turn-minimap__fade turn-minimap__fade--end" aria-hidden="true" />
    <aside v-if="activeItem !== undefined" class="turn-minimap__preview">
      <strong>{{ minimapPreview(activeItem).prompt || "Prompt unavailable" }}</strong>
      <p>{{ minimapPreview(activeItem).assistant || "No assistant prose in this turn." }}</p>
    </aside>
  </nav>
</template>
