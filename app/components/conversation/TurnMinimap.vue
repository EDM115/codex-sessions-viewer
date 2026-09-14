<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { TurnNavigatorItem } from "#shared/types/conversation.ts";

import {
  markerWidthForBucket,
  minimapDestinationIndex,
  minimapPreview,
} from "../../composables/useTurnMinimap.ts";

const props = defineProps<{
  currentTurnId: string | null;
  errorTurnId?: string | null;
  items: readonly TurnNavigatorItem[];
  pendingTurnId?: string | null;
}>();

const emit = defineEmits<{
  select: [turnId: string];
}>();

const activeTurnId = ref<string | null>(null);
const buttons = new Map<number, HTMLButtonElement>();
const scrollTop = ref(0);
const viewportHeight = ref(544);
const markerHeight = ref(12.8);
const windowed = computed(() => props.items.length > 100);
const itemIndexes = computed(() => new Map(props.items.map((item, index) => [item.turnId, index])));
const labels = new WeakMap<TurnNavigatorItem, string>();
const visibleItems = computed(() => {
  const start = windowed.value
    ? Math.max(0, Math.floor(scrollTop.value / markerHeight.value) - 8)
    : 0;
  const end = windowed.value
    ? Math.min(
        props.items.length,
        start + Math.ceil(viewportHeight.value / markerHeight.value) + 16,
      )
    : props.items.length;
  const indexes = new Set(
    Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset),
  );
  const current = props.currentTurnId === null ? 0 : itemIndexes.value.get(props.currentTurnId);
  if (current !== undefined && current < props.items.length) {
    indexes.add(current);
  }
  return [...indexes]
    .toSorted((left, right) => left - right)
    .map((index) => ({ item: props.items[index]!, index }));
});
function markerLabel(item: TurnNavigatorItem): string {
  let label = labels.get(item);
  if (label === undefined) {
    label = `Turn ${item.index + 1}: ${item.promptPreview.replaceAll(/\s+/gu, " ").trim() || "Prompt unavailable"}`;
    labels.set(item, label);
  }
  return label;
}
function setButton(index: number, element: unknown): void {
  if (element instanceof HTMLButtonElement) {
    buttons.set(index, element);
  } else {
    buttons.delete(index);
  }
}
function reveal(index: number): void {
  if (!windowed.value || minimapScroll.value === null) {
    return;
  }
  const top = index * markerHeight.value;
  const element = minimapScroll.value;
  if (
    top < element.scrollTop ||
    top + markerHeight.value > element.scrollTop + element.clientHeight
  ) {
    element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    scrollTop.value = element.scrollTop;
  }
}
const minimap = ref<HTMLElement | null>(null);
const minimapScroll = ref<HTMLElement | null>(null);
const previewCenter = ref<number | null>(null);
let resizeObserver: ResizeObserver | null = null;
const activeItem = computed(
  () => props.items[itemIndexes.value.get(activeTurnId.value ?? "") ?? -1],
);
const activePreview = computed(() =>
  activeItem.value === undefined ? null : minimapPreview(activeItem.value),
);
const previewStyle = computed<Record<string, string> | undefined>(() =>
  previewCenter.value === null
    ? undefined
    : { "--turn-preview-center": `${previewCenter.value}px` },
);

function updatePreviewCenter(): void {
  const container = minimap.value;
  const index = itemIndexes.value.get(activeTurnId.value ?? "") ?? -1;
  const marker = buttons.get(index)?.querySelector<HTMLElement>(".turn-minimap__marker");
  if (container === null || marker === undefined || marker === null) {
    previewCenter.value = null;
    return;
  }
  const containerRect = container.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  previewCenter.value = markerRect.top - containerRect.top + markerRect.height / 2;
}

function activate(item: TurnNavigatorItem): void {
  activeTurnId.value = item.turnId;
  void nextTick().then(updatePreviewCenter);
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
  reveal(destination);
  await nextTick();
  buttons.get(destination)?.focus();
  select(item);
}

watch(
  () => props.currentTurnId,
  async (turnId) => {
    if (turnId === null || activeTurnId.value !== null) {
      await nextTick();
      updatePreviewCenter();
      return;
    }
    await nextTick();
    if (activeTurnId.value !== null) {
      return;
    }
    const index = itemIndexes.value.get(turnId) ?? -1;
    reveal(index);
    await nextTick();
    if (!windowed.value) {
      buttons.get(index)?.scrollIntoView({ block: "center" });
    }
    updatePreviewCenter();
  },
  { immediate: true },
);

watch(
  () => props.items,
  () => void nextTick().then(updatePreviewCenter),
  { deep: false },
);

function handleScroll(): void {
  scrollTop.value = minimapScroll.value?.scrollTop ?? 0;
  updatePreviewCenter();
}

function updateLayout(): void {
  viewportHeight.value = minimapScroll.value?.clientHeight || 544;
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  markerHeight.value = rootFontSize * (window.matchMedia("(pointer: coarse)").matches ? 2.75 : 0.8);
  updatePreviewCenter();
}

onMounted(() => {
  updateLayout();
  reveal(itemIndexes.value.get(props.currentTurnId ?? "") ?? 0);
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(updateLayout);
    if (minimap.value !== null) {
      resizeObserver.observe(minimap.value);
    }
    if (minimapScroll.value !== null) {
      resizeObserver.observe(minimapScroll.value);
    }
  }
});

onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <nav ref="minimap" class="turn-minimap" aria-label="Conversation turns">
    <div class="turn-minimap__fade turn-minimap__fade--start" aria-hidden="true" />
    <div
      ref="minimapScroll"
      class="turn-minimap__scroll"
      @scroll.passive="handleScroll"
      :style="windowed ? { display: 'block' } : undefined"
    >
      <div
        :style="
          windowed
            ? { height: `${items.length * markerHeight}px`, position: 'relative' }
            : { display: 'contents' }
        "
      >
        <button
          v-for="{ item, index } in visibleItems"
          :key="item.turnId"
          :ref="(element) => setButton(index, element)"
          :style="
            windowed
              ? {
                  position: 'absolute',
                  top: `${index * markerHeight}px`,
                  height: `${markerHeight}px`,
                }
              : undefined
          "
          type="button"
          class="turn-minimap__target"
          :class="{
            'is-active': item.turnId === currentTurnId || item.turnId === activeTurnId,
            'is-pending': item.turnId === pendingTurnId,
            'is-error': item.turnId === errorTurnId,
          }"
          :data-turn-id="item.turnId"
          :data-jump-state="
            item.turnId === pendingTurnId
              ? 'pending'
              : item.turnId === errorTurnId
                ? 'error'
                : undefined
          "
          :aria-label="`${markerLabel(item)}${item.turnId === pendingTurnId ? ' · loading' : item.turnId === errorTurnId ? ' · load failed' : ''}`"
          :aria-current="item.turnId === currentTurnId ? 'true' : undefined"
          :aria-busy="item.turnId === pendingTurnId ? 'true' : undefined"
          :disabled="item.turnId === pendingTurnId"
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
    </div>
    <div class="turn-minimap__fade turn-minimap__fade--end" aria-hidden="true" />
    <aside
      v-if="activeItem !== undefined"
      class="turn-minimap__preview"
      role="tooltip"
      :style="previewStyle"
    >
      <strong>{{ activePreview?.prompt || "Prompt unavailable" }}</strong>
      <p>{{ activePreview?.assistant || "No assistant prose in this turn." }}</p>
    </aside>
  </nav>
</template>
