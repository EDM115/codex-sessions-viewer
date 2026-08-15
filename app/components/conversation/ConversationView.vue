<script setup lang="ts">
import { PhArrowDown, PhArrowLeft, PhArrowUp, PhSidebarSimple } from "@phosphor-icons/vue";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

import { shouldAdjustForMeasuredRow } from "#shared/timeline/scrollAnchoring.ts";
import { activeVirtualRowIndex } from "#shared/timeline/turnMinimap.ts";
import type { ConversationSummary, TurnNavigatorItem } from "#shared/types/conversation.ts";
import type {
  InspectorRecord,
  InspectorTarget,
  RepositoryMode,
  TurnChunk,
} from "#shared/types/repository.ts";

import { useConversationTimeline } from "../../composables/useConversationTimeline.ts";
import { usePresentationSettings } from "../../composables/usePresentationSettings.ts";
import {
  type ScrollAnchorSnapshot,
  useScrollAnchoring,
} from "../../composables/useScrollAnchoring.ts";
import { createConversationRepository } from "../../repositories/index.ts";
import type { RepositoryRequester } from "../../repositories/live.ts";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import ConversationInspector from "./ConversationInspector.vue";
import ConversationTurn from "./ConversationTurn.vue";
import { formatTimestamp } from "./format.ts";
import TurnMinimap from "./TurnMinimap.vue";

const props = defineProps<{
  initialChunk: TurnChunk;
  initialTargetTurnId: string | null;
  mode: RepositoryMode;
  navigator: TurnNavigatorItem[];
  summary: ConversationSummary;
}>();

const ESTIMATED_TURN_SIZE = 520;

const route = useRoute();
const router = useRouter();
const requestFetch = useRequestFetch() as unknown as (
  path: string,
  options: { signal?: AbortSignal },
) => Promise<unknown>;
const requester: RepositoryRequester = (path, options = {}) =>
  requestFetch(path, { signal: options.signal }) as Promise<unknown>;
const repository = createConversationRepository(props.mode, requester);
const summaryState = shallowRef(props.summary);
const timeline = useConversationTimeline({
  sessionId: props.summary.id,
  repository,
  initialChunk: props.initialChunk,
});
const { settings } = usePresentationSettings();
const navigatorItems = shallowRef<readonly TurnNavigatorItem[]>([...props.navigator]);
const workbench = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const currentTurnId = ref(props.initialTargetTurnId ?? props.initialChunk.turns.at(-1)?.id ?? null);
const minimapOverlayOpen = ref(false);
const inspectorTarget = shallowRef<InspectorTarget | null>(null);
const inspectorRecord = shallowRef<InspectorRecord | null>(null);
const inspectorLoading = ref(false);
const inspectorError = ref<string | null>(null);
const liveRefreshError = ref<string | null>(null);
const virtualized = ref(false);
let unsubscribe: () => void = () => undefined;
let scrollFrame: number | null = null;
let disclosureAnchor: ScrollAnchorSnapshot | null = null;
let beforeLoadRequest: Promise<void> | null = null;
let liveRefreshRequest: Promise<void> | null = null;
let liveRefreshQueued = false;
let jumpRequestVersion = 0;
let programmaticJumpVersion: number | null = null;
let inspectorRequestVersion = 0;
let inspectorOpener: HTMLElement | null = null;
let disposed = false;

const virtualizer = useVirtualizer(
  computed(() => ({
    count: timeline.turns.value.length,
    estimateSize: () => ESTIMATED_TURN_SIZE,
    getItemKey: (index: number) => timeline.turns.value[index]?.id ?? index,
    getScrollElement: () => scroller.value,
    overscan: 3,
    shouldAdjustScrollPositionOnItemSizeChange: (
      item: VirtualItem,
      _delta: number,
      instance: Virtualizer<HTMLElement, Element>,
    ) => shouldAdjustForMeasuredRow(item, instance.scrollOffset),
  })),
);
const virtualRows = computed(() => (virtualized.value ? virtualizer.value.getVirtualItems() : []));
const virtualSize = computed(() => virtualizer.value.getTotalSize());
const anchoring = useScrollAnchoring(scroller, () => virtualizer.value.measure());
const inspectorOpen = computed(
  () => inspectorTarget.value !== null || inspectorLoading.value || inspectorError.value !== null,
);

function rowStyle(start: number): Record<string, string> {
  return { transform: `translateY(${start}px)` };
}

function alignRenderedTurnAtStart(turnId: string): void {
  const container = scroller.value;
  const element =
    container === null
      ? undefined
      : [...container.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
          ({ dataset }) => dataset["turnId"] === turnId,
        );
  if (container === null || element === undefined) {
    return;
  }
  container.scrollTop +=
    element.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

async function settleRenderedTurnAtStart(turnId: string, remainingFrames = 3): Promise<void> {
  await nextTick();
  alignRenderedTurnAtStart(turnId);
  if (remainingFrames > 0) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await settleRenderedTurnAtStart(turnId, remainingFrames - 1);
  }
}

function measureElement(element: unknown): void {
  if (element instanceof Element) {
    virtualizer.value.measureElement(element);
  }
}

function loadingMessage(direction: "after" | "before"): string {
  return direction === "before" ? "Loading earlier turns…" : "Loading later turns…";
}

async function loadBefore(): Promise<void> {
  if (beforeLoadRequest !== null) {
    return beforeLoadRequest;
  }
  const interactionVersion = jumpRequestVersion;
  let anchor: ScrollAnchorSnapshot | null = null;
  let estimatedAdjustment = 0;
  const request = timeline
    .loadBefore((chunk) => {
      if (interactionVersion === jumpRequestVersion) {
        anchor = anchoring.capture();
        const loadedIds = new Set(timeline.turns.value.map(({ id }) => id));
        estimatedAdjustment =
          chunk.turns.filter(({ id }) => !loadedIds.has(id)).length * ESTIMATED_TURN_SIZE;
      }
    })
    .then(async () => {
      if (interactionVersion === jumpRequestVersion) {
        await nextTick();
        if (scroller.value !== null) {
          scroller.value.scrollTop += estimatedAdjustment;
        }
        await anchoring.restore(anchor);
      }
      return undefined;
    })
    .finally(() => {
      if (beforeLoadRequest === request) {
        beforeLoadRequest = null;
      }
    });
  beforeLoadRequest = request;
  return request;
}

async function loadAfter(): Promise<void> {
  await timeline.loadAfter();
  await nextTick();
  virtualizer.value.measure();
}

function updateCurrentTurn(): void {
  const container = scroller.value;
  const rows = virtualizer.value.getVirtualItems();
  if (container === null || rows.length === 0) {
    return;
  }
  const readingLine = container.scrollTop + container.clientHeight * 0.3;
  const rowIndex = activeVirtualRowIndex(rows, readingLine);
  currentTurnId.value =
    (rowIndex === null ? undefined : timeline.turns.value[rowIndex]?.id) ?? currentTurnId.value;
}

function handleScroll(): void {
  if (scrollFrame !== null) {
    return;
  }
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    const container = scroller.value;
    if (container === null || programmaticJumpVersion !== null) {
      return;
    }
    updateCurrentTurn();
    if (container.scrollTop < 560 && timeline.canLoadBefore.value) {
      void loadBefore();
    }
    if (
      container.scrollHeight - container.scrollTop - container.clientHeight < 560 &&
      timeline.canLoadAfter.value
    ) {
      void loadAfter();
    }
  });
}

function captureDisclosureAnchor(): void {
  disclosureAnchor = anchoring.capture();
}

async function restoreDisclosureAnchor(): Promise<void> {
  await anchoring.restore(disclosureAnchor);
  disclosureAnchor = null;
}

async function jumpToTurn(turnId: string): Promise<void> {
  const requestVersion = ++jumpRequestVersion;
  programmaticJumpVersion = requestVersion;
  try {
    const restoreMinimapFocus = minimapOverlayOpen.value;
    if (restoreMinimapFocus) {
      minimapOverlayOpen.value = false;
      await nextTick();
      focusMinimapToggle();
    }
    await timeline.loadTarget(turnId);
    if (requestVersion !== jumpRequestVersion) {
      return;
    }
    await nextTick();
    virtualizer.value.measure();
    const index = timeline.turns.value.findIndex(({ id }) => id === turnId);
    if (index < 0) {
      return;
    }
    virtualizer.value.scrollToIndex(index, { align: "start" });
    await settleRenderedTurnAtStart(turnId);
    currentTurnId.value = turnId;
    await router.replace({
      query: { ...route.query, turn: turnId },
      hash: `#turn-${turnId}`,
    });
    await nextTick();
    alignRenderedTurnAtStart(turnId);
  } finally {
    if (programmaticJumpVersion === requestVersion) {
      programmaticJumpVersion = null;
    }
  }
}

function inspectorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Conversation information could not be loaded.";
}

function sameInspectorTarget(left: InspectorTarget | null, right: InspectorTarget): boolean {
  return left?.type === right.type && left.id === right.id;
}

async function loadInspector(): Promise<void> {
  const target = inspectorTarget.value;
  if (target === null) {
    return;
  }
  const requestVersion = ++inspectorRequestVersion;
  inspectorLoading.value = true;
  inspectorError.value = null;
  inspectorRecord.value = null;
  try {
    const record = await repository.getInspector(props.summary.id, target);
    if (
      requestVersion === inspectorRequestVersion &&
      sameInspectorTarget(inspectorTarget.value, target)
    ) {
      inspectorRecord.value = record;
    }
  } catch (reason) {
    if (
      requestVersion === inspectorRequestVersion &&
      sameInspectorTarget(inspectorTarget.value, target)
    ) {
      inspectorError.value = inspectorMessage(reason);
    }
  } finally {
    if (
      requestVersion === inspectorRequestVersion &&
      sameInspectorTarget(inspectorTarget.value, target)
    ) {
      inspectorLoading.value = false;
    }
  }
}

function openInspector(target: InspectorTarget): void {
  inspectorOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  inspectorTarget.value = target;
  void loadInspector();
}

function closeInspector(): void {
  inspectorRequestVersion += 1;
  inspectorTarget.value = null;
  inspectorRecord.value = null;
  inspectorError.value = null;
  inspectorLoading.value = false;
  const opener = inspectorOpener;
  inspectorOpener = null;
  void nextTick().then(() => (opener?.isConnected === true ? opener.focus() : undefined));
}

async function refreshLiveSession(): Promise<void> {
  const interactionVersion = jumpRequestVersion;
  const wasNearEnd =
    scroller.value !== null &&
    scroller.value.scrollHeight - scroller.value.scrollTop - scroller.value.clientHeight < 160;
  const [items, summary] = await Promise.all([
    repository.getTurnNavigator(props.summary.id),
    repository.getSession(props.summary.id),
  ]);
  if (disposed) {
    return;
  }
  let anchor: ScrollAnchorSnapshot | null = null;
  await timeline.refresh(currentTurnId.value ?? undefined, () => {
    if (interactionVersion === jumpRequestVersion) {
      anchor = anchoring.capture();
    }
  });
  if (disposed) {
    return;
  }
  navigatorItems.value = items;
  summaryState.value = summary;
  liveRefreshError.value = null;
  if (interactionVersion === jumpRequestVersion) {
    await anchoring.restore(anchor);
  }
  if (settings.liveFollow && wasNearEnd && interactionVersion === jumpRequestVersion) {
    if (timeline.canLoadAfter.value) {
      await timeline.loadAfter();
      if (interactionVersion !== jumpRequestVersion) {
        return;
      }
      await nextTick();
      virtualizer.value.measure();
    }
    virtualizer.value.scrollToIndex(Math.max(0, timeline.turns.value.length - 1), {
      align: "end",
    });
  }
}

function liveRefreshMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Live conversation refresh failed.";
}

function scheduleLiveRefresh(): void {
  if (disposed) {
    return;
  }
  if (liveRefreshRequest !== null) {
    liveRefreshQueued = true;
    return;
  }
  const request = refreshLiveSession()
    .catch((reason: unknown) => {
      if (!disposed) {
        liveRefreshError.value = liveRefreshMessage(reason);
      }
    })
    .finally(() => {
      if (liveRefreshRequest === request) {
        liveRefreshRequest = null;
      }
      if (liveRefreshQueued && !disposed) {
        liveRefreshQueued = false;
        scheduleLiveRefresh();
      }
    });
  liveRefreshRequest = request;
}

function focusMinimapToggle(): void {
  workbench.value
    ?.querySelector<HTMLButtonElement>('button[aria-label="Open turn minimap"]')
    ?.focus();
}

async function toggleMinimapOverlay(): Promise<void> {
  minimapOverlayOpen.value = !minimapOverlayOpen.value;
  await nextTick();
  if (minimapOverlayOpen.value) {
    workbench.value
      ?.querySelector<HTMLButtonElement>('#turn-minimap-panel .turn-minimap__target[tabindex="0"]')
      ?.focus();
  } else {
    focusMinimapToggle();
  }
}

function closeMinimapOverlay(): void {
  if (!minimapOverlayOpen.value) {
    return;
  }
  minimapOverlayOpen.value = false;
  void nextTick().then(focusMinimapToggle);
}

onMounted(async () => {
  await nextTick();
  virtualized.value = true;
  await nextTick();
  virtualizer.value.measure();
  const initialIndex = Math.max(
    0,
    timeline.turns.value.findIndex(({ id }) => id === currentTurnId.value),
  );
  virtualizer.value.scrollToIndex(initialIndex, {
    align: props.initialTargetTurnId === null ? "end" : "start",
  });
  unsubscribe = repository.subscribe((event) => {
    if (event.type === "session.updated" && event.ids.includes(props.summary.id)) {
      scheduleLiveRefresh();
    }
  });
});

onBeforeUnmount(() => {
  disposed = true;
  unsubscribe();
  if (scrollFrame !== null) {
    cancelAnimationFrame(scrollFrame);
  }
});
</script>

<template>
  <main ref="workbench" class="conversation-workbench">
    <header class="conversation-heading">
      <a class="conversation-heading__back" href="/">
        <PhArrowLeft :size="17" weight="regular" aria-hidden="true" /> Library
      </a>
      <div class="conversation-heading__title-row">
        <div>
          <p class="conversation-heading__kicker">
            {{ summaryState.sectionName ?? summaryState.scope }} session
          </p>
          <h1>{{ summaryState.title }}</h1>
        </div>
        <UiIconButton
          v-if="settings.turnMinimap"
          class="conversation-heading__minimap-toggle"
          label="Open turn minimap"
          controls="turn-minimap-panel"
          :expanded="minimapOverlayOpen"
          @click="toggleMinimapOverlay"
        >
          <PhSidebarSimple :size="19" weight="regular" aria-hidden="true" />
        </UiIconButton>
      </div>
      <div class="conversation-heading__metadata">
        <span>{{ summaryState.turnCount }} turns</span>
        <span>{{ summaryState.models.join(", ") || "Model unavailable" }}</span>
        <span v-if="summaryState.cwd !== null">{{ summaryState.cwd }}</span>
        <time :datetime="summaryState.updatedAt" data-allow-mismatch="text"
          >Updated {{ formatTimestamp(summaryState.updatedAt, settings.timestampFormat) }}</time
        >
      </div>
    </header>

    <section class="conversation-stage">
      <div
        ref="scroller"
        class="conversation-timeline"
        aria-label="Conversation timeline"
        tabindex="0"
        @scroll.passive="handleScroll"
      >
        <div class="conversation-timeline__load conversation-timeline__load--before">
          <UiButton
            v-if="timeline.canLoadBefore.value"
            variant="quiet"
            :disabled="timeline.loadingBefore.value"
            @click="loadBefore"
          >
            <PhArrowUp :size="17" weight="regular" aria-hidden="true" />
            {{ timeline.loadingBefore.value ? loadingMessage("before") : "Load earlier turns" }}
          </UiButton>
        </div>
        <p v-if="timeline.error.value !== null" class="conversation-timeline__error" role="status">
          {{ timeline.error.value }}
        </p>
        <div v-if="liveRefreshError !== null" class="conversation-timeline__error" role="status">
          <span>{{ liveRefreshError }}</span>
          <UiButton variant="quiet" @click="scheduleLiveRefresh">Retry refresh</UiButton>
        </div>
        <div
          v-if="virtualRows.length > 0"
          class="conversation-timeline__virtual"
          :style="{ height: `${virtualSize}px` }"
        >
          <div
            v-for="row in virtualRows"
            :key="String(row.key)"
            :ref="measureElement"
            class="conversation-timeline__row"
            :data-index="row.index"
            :style="rowStyle(row.start)"
          >
            <ConversationTurn
              v-if="timeline.turns.value[row.index] !== undefined"
              :turn="timeline.turns.value[row.index]!"
              :reasoning-default="settings.reasoningDefault"
              :tool-calls-default="settings.toolCallsDefault"
              :timestamp-format="settings.timestampFormat"
              @before-resize="captureDisclosureAnchor"
              @resized="restoreDisclosureAnchor"
              @inspect="openInspector"
            />
          </div>
        </div>
        <div v-else class="conversation-timeline__ssr">
          <ConversationTurn
            v-for="turn in timeline.turns.value"
            :key="turn.id"
            :turn="turn"
            :reasoning-default="settings.reasoningDefault"
            :tool-calls-default="settings.toolCallsDefault"
            :timestamp-format="settings.timestampFormat"
            @inspect="openInspector"
          />
        </div>
        <div class="conversation-timeline__load conversation-timeline__load--after">
          <UiButton
            v-if="timeline.canLoadAfter.value"
            variant="quiet"
            :disabled="timeline.loadingAfter.value"
            @click="loadAfter"
          >
            <PhArrowDown :size="17" weight="regular" aria-hidden="true" />
            {{ timeline.loadingAfter.value ? loadingMessage("after") : "Load later turns" }}
          </UiButton>
        </div>
      </div>

      <div
        v-if="settings.turnMinimap"
        id="turn-minimap-panel"
        class="conversation-stage__minimap"
        :class="minimapOverlayOpen ? 'is-open' : null"
        @keydown.esc.stop="closeMinimapOverlay"
      >
        <TurnMinimap
          :items="[...navigatorItems]"
          :current-turn-id="currentTurnId"
          @select="jumpToTurn"
        />
      </div>

      <ConversationInspector
        v-if="inspectorOpen"
        :record="inspectorRecord"
        :loading="inspectorLoading"
        :error="inspectorError"
        @close="closeInspector"
        @retry="loadInspector"
      />
    </section>
  </main>
</template>
