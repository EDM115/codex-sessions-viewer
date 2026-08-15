<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, ref } from "vue";

import type { ConversationSummary } from "#shared/types/conversation.ts";

import LibrarySessionItem from "./LibrarySessionItem.vue";

const props = withDefaults(
  defineProps<{
    items: ConversationSummary[];
    selectedId?: string | null;
  }>(),
  { selectedId: null },
);

const scrollElement = ref<HTMLElement | null>(null);
const virtualized = computed(() => props.items.length > 40);
const rowVirtualizer = useVirtualizer(
  computed(() => ({
    count: props.items.length,
    estimateSize: () => 112,
    getScrollElement: () => scrollElement.value,
    getItemKey: (index: number) => props.items[index]?.id ?? index,
    initialRect: { width: 320, height: 720 },
    overscan: 6,
  })),
);

function groupLabel(index: number): string | undefined {
  const item = props.items[index];
  const previous = props.items[index - 1];
  const label = item?.sectionName ?? item?.updatedAt.slice(0, 10);
  const previousLabel = previous?.sectionName ?? previous?.updatedAt.slice(0, 10);
  return index === 0 || label !== previousLabel ? label : undefined;
}

async function moveFocus(event: KeyboardEvent, index: number): Promise<void> {
  const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (direction === 0) {
    return;
  }
  const targetIndex = Math.max(0, Math.min(props.items.length - 1, index + direction));
  event.preventDefault();
  let target = virtualized.value
    ? scrollElement.value?.querySelector<HTMLAnchorElement>(
        `[data-index="${targetIndex}"] .library-session-item`,
      )
    : scrollElement.value?.querySelectorAll<HTMLAnchorElement>(".library-session-item")[
        targetIndex
      ];
  if (virtualized.value && target === null) {
    rowVirtualizer.value.scrollToIndex(targetIndex, { align: "auto" });
    await nextTick();
    target = scrollElement.value?.querySelector<HTMLAnchorElement>(
      `[data-index="${targetIndex}"] .library-session-item`,
    );
  }
  target?.focus({ preventScroll: true });
}
</script>

<template>
  <nav ref="scrollElement" class="library-session-list" aria-label="Sessions">
    <template v-if="!virtualized">
      <LibrarySessionItem
        v-for="(session, index) in items"
        :key="session.id"
        :session="session"
        :selected="session.id === selectedId"
        :group-label="groupLabel(index)"
        @keydown="moveFocus($event, index)"
      />
    </template>
    <div
      v-else
      class="library-session-list__virtual"
      :style="{ height: `${rowVirtualizer.getTotalSize()}px` }"
    >
      <LibrarySessionItem
        v-for="virtualRow in rowVirtualizer.getVirtualItems()"
        :key="String(virtualRow.key)"
        :data-index="virtualRow.index"
        :ref="
          (element) => element && rowVirtualizer.measureElement((element as { $el: Element }).$el)
        "
        class="library-session-list__virtual-row"
        :style="{ transform: `translateY(${virtualRow.start}px)` }"
        :session="items[virtualRow.index]!"
        :selected="items[virtualRow.index]!.id === selectedId"
        :group-label="groupLabel(virtualRow.index)"
        @keydown="moveFocus($event, virtualRow.index)"
      />
    </div>
  </nav>
</template>
