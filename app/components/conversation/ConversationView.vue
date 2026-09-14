<script setup lang="ts">
import { PhArrowDown, PhArrowLeft, PhArrowUp, PhSidebarSimple } from "@phosphor-icons/vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  useId,
} from "vue";

import { activeVirtualRowIndex } from "#shared/timeline/turnMinimap.ts";
import { installConversationScrollPolicy } from "#shared/timeline/virtualizer.ts";
import type { ConversationSummary, TurnNavigatorItem } from "#shared/types/conversation.ts";
import type {
  InspectorRecord,
  InspectorTarget,
  RepositoryMode,
  TurnChunk,
} from "#shared/types/repository.ts";

import { useConversationTimeline } from "../../composables/useConversationTimeline.ts";
import { useMediaViewer } from "../../composables/useMediaViewer.ts";
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

const MediaViewer = defineAsyncComponent(() => import("../media/MediaViewer.vue"));

const props = defineProps<{
  embedded?: boolean;
  initialChunk: TurnChunk;
  initialTargetTurnId: string | null;
  mode: RepositoryMode;
  navigator: TurnNavigatorItem[];
  summary: ConversationSummary;
}>();

const emit = defineEmits<{ openChild: [sessionId: string] }>();

const minimapInstanceId = useId();
const turnAnchorPrefix = computed(() =>
  props.embedded ? `embedded-${minimapInstanceId}-turn-` : "turn-",
);
const minimapPanelId = computed(() =>
  props.embedded ? `turn-minimap-panel-${minimapInstanceId}` : "turn-minimap-panel",
);
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
const resolveAsset = (assetId: string) => repository.resolveAsset(assetId);
const resolveFavicon = (origin: string) => repository.resolveFavicon(origin);
const mediaViewer = useMediaViewer();
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
const virtualCanvas = ref<HTMLElement | null>(null);
let layoutObserver: ResizeObserver | null = null;
let layoutWidth: number | null = null;
let layoutRestorePending = false;
let layoutRestoreQueued = false;
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
  })),
);
installConversationScrollPolicy(virtualizer.value, () => {
  const container = scroller.value;
  const canvas = virtualCanvas.value;
  return container === null || canvas === null
    ? 0
    : canvas.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
});
const virtualRows = computed(() => (virtualized.value ? virtualizer.value.getVirtualItems() : []));
const virtualSize = computed(() => virtualizer.value.getTotalSize());
const anchoring = useScrollAnchoring(
  scroller,
  (turnId) => {
    const index = timeline.turns.value.findIndex(({ id }) => id === turnId);
    const container = scroller.value;
    const canvas = virtualCanvas.value;
    if (index < 0 || container === null || canvas === null) {
      return null;
    }
    virtualizer.value.getTotalSize();
    const row = virtualizer.value.measurementsCache[index];
    return row === undefined
      ? null
      : row.start +
          canvas.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop;
  },
  () => {
    const container = scroller.value;
    const canvas = virtualCanvas.value;
    if (container === null || canvas === null) {
      return null;
    }
    const origin =
      canvas.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    const row = virtualizer.value.getVirtualItemForOffset(container.scrollTop - origin);
    const turnId = row === undefined ? undefined : timeline.turns.value[row.index]?.id;
    return row === undefined || turnId === undefined
      ? null
      : { turnId, top: row.start + origin - container.scrollTop };
  },
);
const inspectorActivities = computed(() =>
  inspectorOpen.value ? timeline.turns.value.flatMap((turn) => turn.activities) : [],
);
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

async function settleRenderedTurnAtStart(
  turnId: string,
  requestVersion: number,
  remainingFrames = 3,
): Promise<void> {
  await nextTick();
  if (requestVersion !== jumpRequestVersion) {
    return;
  }
  alignRenderedTurnAtStart(turnId);
  if (remainingFrames > 0) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await settleRenderedTurnAtStart(turnId, requestVersion, remainingFrames - 1);
  }
}

function measureElement(element: unknown): void {
  if (!(element instanceof Element)) {
    virtualizer.value.measureElement(null);
    return;
  }
  // Vue invokes function refs before a newly created parent is inserted. Measuring
  // here would cache a detached row's zero height and move the initial range.
  void nextTick().then(() =>
    element.isConnected ? virtualizer.value.measureElement(element) : undefined,
  );
}

function loadingMessage(direction: "after" | "before"): string {
  return direction === "before" ? "Loading earlier turns…" : "Loading later turns…";
}

async function loadBefore(): Promise<void> {
  if (beforeLoadRequest !== null) {
    return beforeLoadRequest;
  }
  let interactionVersion = jumpRequestVersion;
  let anchor: ScrollAnchorSnapshot | null = null;
  const request = timeline
    .loadBefore(() => {
      interactionVersion = jumpRequestVersion;
      anchor = anchoring.capture();
    })
    .then(async () => {
      if (interactionVersion === jumpRequestVersion) {
        await nextTick();
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
}

function updateCurrentTurn(): void {
  const container = scroller.value;
  const rows = virtualizer.value.getVirtualItems();
  if (container === null || rows.length === 0) {
    return;
  }
  const canvasTop = virtualCanvas.value?.getBoundingClientRect().top;
  const readingLine =
    canvasTop === undefined
      ? container.scrollTop + container.clientHeight * 0.3
      : container.getBoundingClientRect().top + container.clientHeight * 0.3 - canvasTop;
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
    anchoring.remember();
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

async function jumpToTurn(turnId: string, updateRoute = true): Promise<void> {
  anchoring.cancel();
  const requestVersion = ++jumpRequestVersion;
  programmaticJumpVersion = requestVersion;
  try {
    const restoreMinimapFocus = minimapOverlayOpen.value;
    if (restoreMinimapFocus) {
      minimapOverlayOpen.value = false;
      await nextTick();
      focusMinimapToggle();
    }
    if (requestVersion !== jumpRequestVersion) {
      return;
    }
    await timeline.loadTarget(turnId, {
      limit: props.mode === "live" ? 5 : 20,
      beforeApply: () => {
        if (requestVersion !== jumpRequestVersion) {
          return;
        }
        if (scroller.value !== null) {
          scroller.value.scrollTop = 0;
        }
      },
    });
    if (requestVersion !== jumpRequestVersion) {
      return;
    }
    await nextTick();
    const index = timeline.turns.value.findIndex(({ id }) => id === turnId);
    if (index < 0) {
      return;
    }
    virtualizer.value.scrollToIndex(index, { align: "start" });
    await settleRenderedTurnAtStart(turnId, requestVersion);
    if (requestVersion !== jumpRequestVersion) {
      return;
    }
    currentTurnId.value = turnId;
    if (updateRoute && !props.embedded) {
      await router.replace({
        query: { ...route.query, turn: turnId },
        hash: `#turn-${turnId}`,
      });
    }
    await nextTick();
    alignRenderedTurnAtStart(turnId);
    anchoring.remember();
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
    anchor = anchoring.capture();
  });
  if (disposed) {
    return;
  }
  navigatorItems.value = items;
  summaryState.value = summary;
  liveRefreshError.value = null;
  await anchoring.restore(anchor);
  if (settings.liveFollow && wasNearEnd && interactionVersion === jumpRequestVersion) {
    if (timeline.canLoadAfter.value) {
      await timeline.loadAfter();
      if (interactionVersion !== jumpRequestVersion) {
        return;
      }
      await nextTick();
    }
    anchoring.cancel();
    virtualizer.value.scrollToIndex(Math.max(0, timeline.turns.value.length - 1), {
      align: "end",
    });
    await nextTick();
    anchoring.remember();
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
      ?.querySelector<HTMLButtonElement>('.turn-minimap__target[tabindex="0"]')
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

function handleReadInput(event: Event): void {
  if (
    event instanceof KeyboardEvent &&
    !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
  ) {
    return;
  }
  anchoring.cancel();
  timeline.cancelTarget();
  jumpRequestVersion += 1;
  programmaticJumpVersion = null;
}

watch(
  () => props.initialTargetTurnId,
  (turnId) => {
    if (turnId !== null && turnId !== currentTurnId.value) {
      void jumpToTurn(turnId, false);
    }
  },
);

// ResizeObserver remains active after restoration, including late images and diagrams.
watch(virtualCanvas, (canvas, previous) => {
  if (previous !== null) {
    layoutObserver?.unobserve(previous);
  }
  if (canvas !== null) {
    layoutObserver?.observe(canvas);
  }
});

function restoreLayoutAnchor(): void {
  if (disposed || programmaticJumpVersion !== null) {
    return;
  }
  if (layoutRestorePending) {
    layoutRestoreQueued = true;
    return;
  }
  const width = scroller.value?.clientWidth ?? 0;
  const anchor = anchoring.snapshot ?? anchoring.capture();
  if (layoutWidth !== null && width !== layoutWidth) {
    virtualizer.value.measure();
  }
  layoutWidth = width;
  layoutRestorePending = true;
  void anchoring.restore(anchor).finally(() => {
    layoutRestorePending = false;
    if (layoutRestoreQueued) {
      layoutRestoreQueued = false;
      restoreLayoutAnchor();
    }
  });
}

onMounted(async () => {
  layoutObserver = new ResizeObserver(restoreLayoutAnchor);
  if (scroller.value !== null) {
    layoutObserver.observe(scroller.value);
  }
  if (virtualCanvas.value !== null) {
    layoutObserver.observe(virtualCanvas.value);
  }
  await nextTick();
  virtualized.value = true;
  await nextTick();
  const initialIndex = Math.max(
    0,
    timeline.turns.value.findIndex(({ id }) => id === currentTurnId.value),
  );
  virtualizer.value.scrollToIndex(initialIndex, {
    align: props.initialTargetTurnId === null ? "end" : "start",
  });
  if (props.initialTargetTurnId !== null) {
    await jumpToTurn(props.initialTargetTurnId, false);
  }
  await nextTick();
  anchoring.remember();
  unsubscribe = repository.subscribe((event) => {
    if (event.type === "session.updated" && event.ids.includes(props.summary.id)) {
      scheduleLiveRefresh();
    }
  });
});

onBeforeUnmount(() => {
  disposed = true;
  timeline.cancelTarget();
  anchoring.cancel();
  layoutObserver?.disconnect();
  unsubscribe();
  if (scrollFrame !== null) {
    cancelAnimationFrame(scrollFrame);
  }
});
</script>

<template>
  <component
    :is="embedded ? 'section' : 'main'"
    ref="workbench"
    class="conversation-workbench"
    :class="{ 'is-embedded': embedded }"
  >
    <header class="conversation-heading">
      <NuxtLink v-if="!embedded" class="conversation-heading__back" to="/">
        <PhArrowLeft :size="17" weight="regular" aria-hidden="true" /> Library
      </NuxtLink>
      <div class="conversation-heading__title-row">
        <div>
          <p class="conversation-heading__kicker">
            {{ summaryState.sectionName ?? summaryState.scope }} session
          </p>
          <component :is="embedded ? 'h2' : 'h1'">{{ summaryState.title }}</component>
        </div>
        <div class="conversation-heading__actions">
          <slot name="actions" :summary="summaryState" />
          <UiIconButton
            v-if="settings.turnMinimap"
            class="conversation-heading__minimap-toggle"
            label="Open turn minimap"
            :controls="minimapPanelId"
            :expanded="minimapOverlayOpen"
            @click="toggleMinimapOverlay"
          >
            <PhSidebarSimple :size="19" weight="regular" aria-hidden="true" />
          </UiIconButton>
        </div>
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
        @wheel.passive="handleReadInput"
        @pointerdown.capture="handleReadInput"
        @keydown.capture="handleReadInput"
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
          v-if="virtualized"
          ref="virtualCanvas"
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
              :anchor-prefix="turnAnchorPrefix"
              :reasoning-default="settings.reasoningDefault"
              :resolve-asset="resolveAsset"
              :resolve-favicon="resolveFavicon"
              :tool-calls-default="settings.toolCallsDefault"
              :timestamp-format="settings.timestampFormat"
              @before-resize="captureDisclosureAnchor"
              @resized="restoreDisclosureAnchor"
              @inspect="openInspector"
              @open-media="mediaViewer.open"
              @open-child="emit('openChild', $event)"
            />
          </div>
        </div>
        <div v-else class="conversation-timeline__ssr">
          <ConversationTurn
            v-for="turn in timeline.turns.value"
            :key="turn.id"
            :turn="turn"
            :anchor-prefix="turnAnchorPrefix"
            :reasoning-default="settings.reasoningDefault"
            :resolve-asset="resolveAsset"
            :resolve-favicon="resolveFavicon"
            :tool-calls-default="settings.toolCallsDefault"
            :timestamp-format="settings.timestampFormat"
            @inspect="openInspector"
            @open-media="mediaViewer.open"
            @open-child="emit('openChild', $event)"
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
        :id="minimapPanelId"
        class="conversation-stage__minimap"
        :class="minimapOverlayOpen ? 'is-open' : null"
        @keydown.esc.stop="closeMinimapOverlay"
      >
        <TurnMinimap
          :items="navigatorItems"
          :current-turn-id="currentTurnId"
          :pending-turn-id="timeline.pendingTurnId.value"
          :error-turn-id="timeline.targetErrorTurnId.value"
          @select="jumpToTurn($event)"
        />
      </div>

      <ConversationInspector
        v-if="inspectorOpen"
        :record="inspectorRecord"
        :activities="inspectorActivities"
        @inspect="openInspector"
        :loading="inspectorLoading"
        :error="inspectorError"
        @close="closeInspector"
        @retry="loadInspector"
      />
    </section>
  </component>
  <MediaViewer
    v-if="mediaViewer.item.value !== null"
    :item="mediaViewer.item.value"
    :background="workbench ?? undefined"
    @close="mediaViewer.close"
  />
</template>

<style scoped>
.conversation-heading__actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.conversation-workbench.is-embedded {
  height: 100%;
  min-height: 0;
}
</style>
