<script setup lang="ts">
import {
  historyGapBeforeItemIds,
  historyWindowPresentation,
  historyWindowInspector,
} from "#shared/timeline/historyPresentation.ts";
import type { HistoryNavigatorPage, HistoryTurnWindow } from "#shared/types/history.ts";
import type { CatalogSessionMetadata } from "#shared/types/library.ts";
import type {
  ConversationRepository,
  InspectorRecord,
  InspectorTarget,
} from "#shared/types/repository.ts";

const props = defineProps<{
  metadata: CatalogSessionMetadata;
  repository: ConversationRepository;
  targetTurnId: string | null;
}>();
const emit = defineEmits<{ openChild: [id: string] }>();
const surface = useTemplateRef<HTMLElement>("historySurface");
const workbench = useTemplateRef<HTMLElement>("historyWorkbench");
const canvas = useTemplateRef<HTMLElement>("historyCanvas");
const mediaViewer = useMediaViewer();
const resolveAsset = (id: string) => props.repository.resolveAsset(id);
const resolveFavicon = (origin: string) => props.repository.resolveFavicon(origin);
let revealGeneration = 0;
const selectionId = props.metadata.id;
const timeline = useProgressiveHistoryTimeline({
  sessionId: selectionId,
  repository: props.repository,
  beforeApply: () => viewport.capture(),
  afterApply: () => {
    void viewport.settle();
  },
});
const { settings } = usePresentationSettings();
const viewport = useMeasuredConversationViewport({
  keys: () =>
    timeline.windows.value.map((window) =>
      JSON.stringify([window.physicalRolloutId, window.turnId]),
    ),
  surface,
  canvas,
  storageKey: props.metadata.id,
  followEnabled: () => settings.liveFollow,
});
timeline.setVisible([]);
watch(
  () => viewport.rows.value.map((row) => String(row.key)),
  (keys) => timeline.setVisible(keys),
);
function readInput(event: Event) {
  revealGeneration++;
  viewport.readInput(event);
  timeline.cancelTarget();
}
async function latest() {
  timeline.setVisible([]);
  await timeline.refresh();
  await viewport.latest();
}

async function expandedDetailsChanged() {
  await nextTick();
  const entries = surface.value?.querySelectorAll<HTMLElement>("[data-entry-id]") ?? [];
  timeline.setExpanded(
    [...entries].flatMap((entry) => {
      if (!entry.querySelector(".rich-text-document")) {
        return [];
      }
      const key = entry.closest<HTMLElement>("[data-anchor-turn-id]")?.dataset["anchorTurnId"];
      return key ? [`${key}:${entry.dataset["entryId"]}`] : [];
    }),
  );
  await viewport.settle();
}
const approvalOwner = computed(() =>
  JSON.stringify([
    props.metadata.id,
    timeline.stale.value,
    timeline.windows.value.map((window) => [
      window.physicalRolloutId,
      window.turnId,
      window.historyEpoch,
      window.contentRevision,
    ]),
  ]),
);
const approvals = useApprovalEvidence(
  () => props.repository,
  () => props.metadata.id,
  approvalOwner,
);
const messageKeysByIdentity = new Map<string, string>();
const presented = computed(() => {
  const activeIdentities = new Set<string>();
  const entries = viewport.rows.value.flatMap((row) => {
    const window = timeline.windows.value[row.index];
    if (!window) {
      return [];
    }
    const turn = historyWindowPresentation(props.metadata.id, window, timeline.presentations.value);
    const owner = JSON.stringify([window.physicalRolloutId, window.turnId, window.historyEpoch]);
    const messageKeys = Object.fromEntries(
      Object.entries(turn.messageAliases).map(([id, aliases]) => {
        const key =
          messageKeysByIdentity.get(`${owner}:${id}`) ??
          aliases
            .map((alias) => messageKeysByIdentity.get(`${owner}:${alias}`))
            .find((value) => value !== undefined) ??
          `${owner}:${id}`;
        for (const alias of aliases) {
          activeIdentities.add(`${owner}:${alias}`);
          messageKeysByIdentity.set(`${owner}:${alias}`, key);
        }
        return [id, key];
      }),
    );
    return {
      window,
      row,
      turn: approvals.present(turn),
      messageKeys,
      gapBeforeItemIds: historyGapBeforeItemIds(window),
      unresolvedDetails:
        window.opening.availability === "unresolved" ||
        window.items.some((item) => item.detail === "unresolved"),
      unsupportedDetails: window.items.some((item) => item.detail === "unsupported"),
    };
  });
  for (const key of messageKeysByIdentity.keys()) {
    if (!activeIdentities.has(key)) {
      messageKeysByIdentity.delete(key);
    }
  }
  return entries;
});
const inspection = shallowRef<InspectorRecord | null>(null);
function inspect(window: HistoryTurnWindow, target: InspectorTarget) {
  if (props.metadata.id !== selectionId) {
    inspection.value = null;
    return;
  }
  const current = timeline.windows.value.find(
    (entry) =>
      entry.physicalRolloutId === window.physicalRolloutId &&
      entry.turnId === window.turnId &&
      entry.historyEpoch === window.historyEpoch &&
      entry.contentRevision === window.contentRevision,
  );
  if (!current) {
    inspection.value = null;
    return;
  }
  const record = historyWindowInspector(selectionId, current, target);
  inspection.value = record ? structuredClone(record) : null;
}
function inspectRelated(target: InspectorTarget) {
  const owner = inspection.value?.historySnapshot;
  const window = timeline.windows.value.find(
    (entry) =>
      entry.physicalRolloutId === owner?.physicalRolloutId &&
      entry.turnId === owner.turnId &&
      entry.historyEpoch === owner.historyEpoch &&
      entry.contentRevision === owner.contentRevision,
  );
  if (window) {
    inspect(window, target);
  }
}
watch(
  [
    () => props.metadata.id,
    () => timeline.page.value?.historyEpoch,
    () => timeline.page.value?.contentRevision,
    () => timeline.stale.value,
  ],
  () => {
    inspection.value = null;
  },
  { flush: "sync" },
);
const navigator = shallowRef<HistoryNavigatorPage | null>(null);
const navigatorController = new AbortController();
async function revealTarget(turnId: string) {
  const generation = ++revealGeneration;
  await timeline.loadTarget(turnId);
  if (generation !== revealGeneration) {
    return;
  }
  await nextTick();
  const target = timeline.windows.value.find(
    (window) => window.turnId === turnId || window.boundary?.identityAliases.includes(turnId),
  );
  if (!target) {
    return;
  }
  await viewport.target(JSON.stringify([target.physicalRolloutId, target.turnId]));
}
async function loadNavigator(cursor?: string) {
  try {
    const result = await props.repository.getHistoryNavigator(
      props.metadata.id,
      { anchor: cursor ? { kind: "before", cursor } : { kind: "latest" }, limit: 5 },
      { signal: navigatorController.signal },
    );
    if (!navigatorController.signal.aborted) {
      navigator.value = result;
    }
  } catch {
    /* History remains usable while navigator coverage is unavailable */
  }
}
let unsubscribe = () => {};
onMounted(() => {
  const restored = viewport.restoredPosition;
  if (props.targetTurnId) {
    void revealTarget(props.targetTurnId);
  } else if (restored) {
    const [, turnId] = JSON.parse(restored.turnId) as [string, string];
    void timeline.loadTarget(turnId).then(() => viewport.target(restored.turnId, restored.top));
  } else {
    void timeline.refresh().then(() => viewport.latest());
  }
  void loadNavigator();
  unsubscribe = props.repository.subscribe((event) => {
    if (event.type === "session.updated" && event.ids.includes(props.metadata.id)) {
      viewport.latestAvailable.value = !viewport.follow.value || !settings.liveFollow;
      void timeline.refresh();
    }
  });
});
watch(
  () => props.targetTurnId,
  (turnId) => {
    if (turnId) {
      void revealTarget(turnId);
    }
  },
);
onBeforeUnmount(() => {
  unsubscribe();
  timeline.dispose();
  navigatorController.abort();
});
</script>

<template>
  <section ref="historyWorkbench" class="progressive-workbench">
    <header class="conversation-heading">
      <h1 class="theme-display">{{ metadata.title }}</h1>
      <p v-if="timeline.stale.value" role="status">
        Showing previously loaded history while the source is checked.
      </p>
      <p v-if="timeline.error.value" role="status">
        {{ timeline.error.value }}
        <button type="button" @click="timeline.refresh()">Retry history</button>
      </p>
      <p v-if="timeline.loading.value" role="status">Loading history…</p>
      <slot name="actions" :summary="metadata" />
      <ConversationApprovals
        v-if="repository.getApprovalEvidence"
        :evidence="approvals.evidence.value"
        :loading="approvals.loading.value"
        :error="approvals.error.value"
        :disclosure-key="metadata.id"
        @load="approvals.load"
      />
    </header>
    <nav v-if="navigator" aria-label="Loaded turn navigation">
      <span>{{
        navigator.coverage.status === "complete" ? "Turn navigation" : "Partial turn navigation"
      }}</span>
      <button
        v-for="turn in navigator.turns"
        :key="`${turn.physicalRolloutId}:${turn.turnId}`"
        type="button"
        @click="revealTarget(turn.turnId)"
      >
        {{ turn.promptPreview ?? "Opening not loaded" }}
      </button>
      <button
        v-if="navigator.beforeCursor"
        type="button"
        @click="loadNavigator(navigator.beforeCursor)"
      >
        Older navigation
      </button>
    </nav>
    <section
      ref="historySurface"
      class="progressive-conversation"
      :data-history-origin="viewport.origin.value"
      :data-retained-turns="timeline.windows.value.length"
      :data-retained-items="
        timeline.windows.value.reduce((count, window) => count + window.items.length, 0)
      "
      tabindex="0"
      aria-label="Conversation timeline"
      @toggle.capture="expandedDetailsChanged"
      @scroll.passive="viewport.scroll"
      @wheel.passive="readInput"
      @keydown.capture="readInput"
      @pointerdown.capture="readInput"
    >
      <div class="history-load">
        <button v-if="timeline.canLoadBefore.value" type="button" @click="timeline.loadBefore()">
          Load older turns
        </button>
      </div>
      <button
        v-if="viewport.latestAvailable.value || !viewport.follow.value"
        class="history-latest"
        type="button"
        @click="latest"
      >
        Latest content
      </button>
      <div
        ref="historyCanvas"
        class="history-canvas"
        :style="{ height: `${viewport.size.value}px` }"
      >
        <article
          v-for="entry in presented"
          :key="String(entry.row.key)"
          :ref="viewport.measure"
          class="history-row"
          :data-index="entry.row.index"
          :data-anchor-turn-id="String(entry.row.key)"
          :style="{ transform: `translateY(${entry.row.start - viewport.origin.value}px)` }"
          :data-history-turn="entry.window.turnId"
          :data-history-physical="entry.window.physicalRolloutId"
        >
          <p
            v-if="
              entry.window.opening.availability === 'notLoaded' ||
              entry.window.opening.availability === 'unresolved'
            "
          >
            {{
              entry.window.opening.availability === "unresolved"
                ? "Opening prompt needs source verification"
                : "Opening prompt not loaded"
            }}
            <button
              type="button"
              @click="timeline.loadItems(entry.window.turnId, { kind: 'opening' })"
            >
              Load opening
            </button>
          </p>
          <p
            v-if="entry.window.loadedRanges.length > 1 || entry.window.coverage.gaps.length"
            class="history-gap"
            role="status"
          >
            Some history between the loaded items is not loaded.
          </p>
          <p v-if="entry.unresolvedDetails" role="status">
            Previously loaded item details are awaiting source verification.
          </p>
          <p
            v-if="entry.unsupportedDetails || entry.window.opening.availability === 'unsupported'"
            role="status"
          >
            Some item formats are unsupported.
          </p>
          <button
            v-if="entry.window.beforeCursor"
            type="button"
            @click="
              timeline.loadItems(entry.window.turnId, {
                kind: 'before',
                cursor: entry.window.beforeCursor,
              })
            "
          >
            Load older items
          </button>
          <ConversationTurn
            :message-keys="entry.messageKeys"
            :disclosure-key="`${metadata.id}:${entry.window.physicalRolloutId}:${entry.window.turnId}`"
            :unloaded-before="entry.gapBeforeItemIds"
            :turn="entry.turn"
            :reasoning-default="settings.reasoningDefault"
            :timestamp-format="settings.timestampFormat"
            :tool-calls-default="settings.toolCallsDefault"
            :resolve-asset="resolveAsset"
            :resolve-favicon="resolveFavicon"
            @before-resize="viewport.capture"
            @resized="expandedDetailsChanged"
            @open-child="emit('openChild', $event)"
            @open-media="mediaViewer.open($event)"
            @inspect="inspect(entry.window, $event)"
          />
          <button
            v-if="entry.window.preparation?.cursor"
            type="button"
            @click="timeline.prepare(entry.window.turnId)"
          >
            Continue
            {{
              entry.window.preparation.kind === "updates"
                ? "checking item details"
                : "finding the opening"
            }}
          </button>
          <button
            v-if="
              entry.window.afterCursor &&
              entry.window.afterCursor !== entry.window.preparation?.cursor
            "
            type="button"
            @click="
              timeline.loadItems(entry.window.turnId, {
                kind: 'after',
                cursor: entry.window.afterCursor,
              })
            "
          >
            Load newer items
          </button>
        </article>
      </div>
      <button v-if="timeline.canLoadAfter.value" type="button" @click="timeline.loadAfter()">
        Load newer turns
      </button>
      <p v-if="timeline.page.value?.coverage.status === 'complete' && !presented.length">
        This conversation has no turns.
      </p>
    </section>
    <ConversationInspector
      v-if="inspection"
      :record="inspection"
      :loading="false"
      :error="null"
      @close="inspection = null"
      @inspect="inspectRelated"
    />
  </section>
  <LazyMediaViewer
    v-if="mediaViewer.item.value !== null"
    :item="mediaViewer.item.value"
    :background="workbench ?? undefined"
    @close="mediaViewer.close"
  />
</template>

<style scoped>
.progressive-workbench {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 1.5rem;
  position: relative;
}
.progressive-conversation {
  overflow: auto;
  flex: 1;
  min-height: 0;
  overflow-anchor: none;
}
.history-load {
  min-height: 2rem;
}
.history-canvas {
  position: relative;
  width: 100%;
}
.history-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  min-width: 0;
}
.history-latest {
  position: absolute;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 2;
}
.history-gap {
  padding: 0.75rem;
  border-block: 1px dashed currentColor;
}
</style>
