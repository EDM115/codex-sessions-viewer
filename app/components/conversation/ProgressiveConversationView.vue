<script setup lang="ts">
import {
  historyGapBeforeItemIds,
  historyWindowPresentation,
  historyWindowInspector,
  historyWindowMessageIdentity,
} from "#shared/timeline/historyPresentation.ts";
import type { ConversationActivity } from "#shared/types/conversation.ts";
import type { HistoryNavigatorPage, HistoryTurnWindow } from "#shared/types/history.ts";
import type { CatalogSessionMetadata } from "#shared/types/library.ts";
import type {
  ConversationRepository,
  InspectorRecord,
  InspectorTarget,
  HistoryPageQuery,
} from "#shared/types/repository.ts";
import type { ScrollAnchorSnapshot } from "~/composables/useScrollAnchoring.ts";

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
provideLinkPreviewResolver(props.repository.resolveLinkPreview?.bind(props.repository));
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
const historyStatuses = computed(() =>
  [
    timeline.stale.value ? "Showing previously loaded history while the source is checked." : null,
    timeline.loading.value ? "Loading history…" : null,
  ].filter((status) => status !== null),
);
const viewport = useMeasuredConversationViewport({
  keys: () =>
    timeline.windows.value.map((window) =>
      JSON.stringify([window.physicalRolloutId, window.turnId]),
    ),
  surface,
  canvas,
  storageKey: props.metadata.id,
  followEnabled: () => settings.liveFollow,
  canFollow: () => timeline.page.value !== null && !timeline.canLoadAfter.value,
  sourceIdentity: (key) => {
    const window = timeline.windows.value.find(
      (entry) => JSON.stringify([entry.physicalRolloutId, entry.turnId]) === key,
    );
    return window
      ? JSON.stringify([selectionId, window.physicalRolloutId, window.turnId, window.historyEpoch])
      : null;
  },
  entryRetained,
});
timeline.setVisible([]);
watch(
  () => viewport.rows.value.map((row) => String(row.key)),
  (keys) => timeline.setVisible(keys),
);
function readInput(event: Event) {
  if (viewport.readInput(event)) {
    timeline.cancelTarget();
  }
}
function readScroll() {
  if (viewport.scroll()) {
    timeline.cancelTarget();
  }
}
async function latest() {
  const owner = viewport.beginNavigation();
  timeline.setVisible([]);
  try {
    await timeline.refresh(owner);
    if (owner.isCurrent()) {
      await viewport.latest(owner);
    }
  } finally {
    timeline.releaseTarget(owner);
    viewport.finishNavigation(owner);
  }
}

async function expandedDetailsChanged() {
  await nextTick();
  const entries = surface.value?.querySelectorAll<HTMLElement>("[data-entry-id]") ?? [];
  timeline.setExpanded(
    [...entries].flatMap((entry) => {
      if (
        !entry.querySelector(".rich-text-document") &&
        !entry.matches(".conversation-attachment")
      ) {
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
type MessageKeyOwner = { key: string; identityId: string; members: string[]; known: boolean };
const messageOwners = new Map<
  string,
  { token: symbol; groups: MessageKeyOwner[]; keys: Record<string, string> }
>();
const windowTokens = new WeakMap<HistoryTurnWindow, symbol>();
const messageIdentities = new WeakMap<
  HistoryTurnWindow,
  ReturnType<typeof historyWindowMessageIdentity>
>();
function windowToken(window: HistoryTurnWindow) {
  let token = windowTokens.get(window);
  if (!token) {
    token = Symbol();
    windowTokens.set(window, token);
  }
  return token;
}
const windowOwner = (window: HistoryTurnWindow) =>
  JSON.stringify([window.physicalRolloutId, window.turnId, window.historyEpoch]);
const retainedIds = (window: HistoryTurnWindow) =>
  new Set([
    ...window.items.map((item) => item.itemId),
    ...(window.opening.itemId === null ? [] : [window.opening.itemId]),
  ]);
function retainedMessageIdentity(window: HistoryTurnWindow) {
  let identity = messageIdentities.get(window);
  if (!identity) {
    identity = historyWindowMessageIdentity(window);
    messageIdentities.set(window, identity);
  }
  return identity;
}
function messageOwnership(window: HistoryTurnWindow) {
  const owner = windowOwner(window);
  const token = windowToken(window);
  const previous = messageOwners.get(owner);
  if (previous?.token === token) {
    return previous;
  }
  const identity = retainedMessageIdentity(window);
  const classes = Object.entries(identity.messageAliases).map(([id, members]) => ({
    id,
    members,
    known: true,
  }));
  const knownIds = new Set(classes.flatMap((group) => group.members));
  for (const id of identity.unknownIds) {
    if (!knownIds.has(id)) {
      classes.push({ id, members: [id], known: false });
    }
  }
  const claims = new Map<string, MessageKeyOwner[]>();
  const retained = retainedIds(window);
  for (const prior of previous?.groups ?? []) {
    const designated = classes.find((group) => group.members.includes(prior.identityId));
    const successors = designated
      ? [designated]
      : retained.has(prior.identityId)
        ? []
        : classes.filter((group) => group.members.some((id) => prior.members.includes(id)));
    if (successors.length === 1) {
      const id = successors[0]!.id;
      claims.set(id, [...(claims.get(id) ?? []), prior]);
    }
  }
  const inherited = classes.map((group) => {
    const candidates = claims.get(group.id) ?? [];
    return [group.id, ...group.members]
      .map((id) => messageKeysByIdentity.get(`${owner}:${id}`))
      .find((key) => key !== undefined && candidates.some((candidate) => candidate.key === key));
  });
  const used = new Set((previous?.groups ?? []).map((group) => group.key));
  const groups = classes.map((group, index): MessageKeyOwner => {
    let key = inherited[index];
    if (key === undefined) {
      const base = `${owner}:${group.id}`;
      key = base;
      let suffix = 1;
      while (used.has(key)) {
        key = `${base}:split:${suffix++}`;
      }
      used.add(key);
    }
    return { key, identityId: group.id, members: group.members, known: group.known };
  });
  for (const group of previous?.groups ?? []) {
    for (const id of group.members) {
      messageKeysByIdentity.delete(`${owner}:${id}`);
    }
  }
  for (const group of groups) {
    for (const id of group.members) {
      messageKeysByIdentity.set(`${owner}:${id}`, group.key);
    }
  }
  const current = {
    token,
    groups,
    keys: Object.fromEntries(
      groups.filter((group) => group.known).map((group) => [group.identityId, group.key]),
    ),
  };
  messageOwners.set(owner, current);
  return current;
}
let publishedEntries: Array<{
  window: HistoryTurnWindow;
  turn: { activities: readonly ConversationActivity[] };
}> = [];
let activityEvidence: {
  owner: string;
  key: string;
  token: symbol;
  sourceItemIds: string[];
  present: boolean | undefined;
} | null = null;
function entryRetained(key: string, entry: string): boolean | undefined {
  const window = timeline.windows.value.find(
    (candidate) => JSON.stringify([candidate.physicalRolloutId, candidate.turnId]) === key,
  );
  if (!window) {
    activityEvidence = null;
    return false;
  }
  const owner = windowOwner(window);
  if (activityEvidence?.owner !== owner || activityEvidence.key !== entry) {
    activityEvidence = null;
  }
  if (!entry.startsWith("message:") && !entry.startsWith("activity:")) {
    return undefined;
  }
  if (entry.startsWith("message:")) {
    const current = messageOwnership(window);
    const group = current.groups.find((candidate) => `message:${candidate.key}` === entry);
    return group
      ? group.known
        ? true
        : undefined
      : current.groups.some((candidate) => !candidate.known)
        ? undefined
        : false;
  }
  const token = windowToken(window);
  const ids = retainedIds(window);
  if (activityEvidence?.sourceItemIds.some((id) => !ids.has(id))) {
    activityEvidence = null;
    return false;
  }
  const published = publishedEntries.find((candidate) => candidate.window === window);
  if (published) {
    const activity = published.turn.activities.find(
      (candidate) => `activity:${candidate.id}` === entry,
    );
    if (
      !activity &&
      (window.items.some((item) => item.item === null) ||
        (window.opening.itemId !== null && window.opening.item === null))
    ) {
      return undefined;
    }
    activityEvidence = {
      owner,
      key: entry,
      token,
      sourceItemIds: activity
        ? [activity.id, ...activity.rawEventIds].filter((id) => ids.has(id))
        : [],
      present: activity !== undefined,
    };
    return activityEvidence.present;
  }
  const rawId = entry.slice("activity:".length);
  if (!activityEvidence && ids.has(rawId)) {
    activityEvidence = { owner, key: entry, token, sourceItemIds: [rawId], present: undefined };
  }
  return activityEvidence?.token === token ? activityEvidence.present : undefined;
}
const presented = computed(() => {
  const entries = viewport.rows.value.flatMap((row) => {
    const window = timeline.windows.value[row.index];
    if (!window) {
      return [];
    }
    const turn = historyWindowPresentation(
      props.metadata.id,
      window,
      timeline.presentations.value,
      retainedMessageIdentity(window),
    );
    const messageKeys = messageOwnership(window).keys;
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
  publishedEntries = entries;
  const retained = new Map(
    timeline.windows.value.map((window) => [windowOwner(window), retainedIds(window)]),
  );
  for (const [owner, state] of messageOwners) {
    const ids = retained.get(owner);
    for (const group of state.groups) {
      for (const id of group.members) {
        if (!ids?.has(id)) {
          messageKeysByIdentity.delete(`${owner}:${id}`);
        }
      }
      group.members = group.members.filter((id) => ids?.has(id));
    }
    state.groups = state.groups.filter((group) => group.members.length > 0);
    state.keys = Object.fromEntries(
      state.groups
        .filter((group) => group.known && ids?.has(group.identityId))
        .map((group) => [group.identityId, group.key]),
    );
    if (!ids || state.groups.length === 0) {
      messageOwners.delete(owner);
    }
  }
  if (activityEvidence && !retained.has(activityEvidence.owner)) {
    activityEvidence = null;
  }
  return entries;
});
onBeforeUnmount(() => {
  publishedEntries = [];
  activityEvidence = null;
  messageOwners.clear();
  messageKeysByIdentity.clear();
});
const inspection = shallowRef<InspectorRecord | null>(null);
let inspectionOpener: HTMLElement | null = null;
let inspectionAction = 0;
let inspectionDisposed = false;
function closeInspection() {
  const action = ++inspectionAction;
  const opener = inspectionOpener;
  inspectionOpener = null;
  inspection.value = null;
  void nextTick().then(() => {
    if (!inspectionDisposed && action === inspectionAction && opener?.isConnected) {
      opener.focus();
    }
    return undefined;
  });
}
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
  inspectionAction += 1;
  if (inspection.value === null) {
    inspectionOpener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
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
  (current, previous) => {
    if (current.slice(0, 3).some((value, index) => value !== previous[index])) {
      inspectionAction += 1;
    }
    inspectionOpener = null;
    inspection.value = null;
  },
  { flush: "sync" },
);
const navigator = shallowRef<HistoryNavigatorPage | null>(null);
const navigatorError = ref<string | null>(null);
let navigatorController = new AbortController();
let navigatorDisposed = false;
let navigatorQuery: HistoryPageQuery = { anchor: { kind: "latest" }, limit: 5 };
async function revealTarget(turnId: string, restored?: ScrollAnchorSnapshot) {
  const owner = viewport.beginNavigation();
  try {
    await timeline.loadTarget(turnId, owner);
    if (!owner.isCurrent()) {
      return;
    }
    await nextTick();
    if (!owner.isCurrent()) {
      return;
    }
    const target = timeline.windows.value.find(
      (window) => window.turnId === turnId || window.boundary?.identityAliases.includes(turnId),
    );
    if (target) {
      await viewport.target(
        JSON.stringify([target.physicalRolloutId, target.turnId]),
        restored?.top ?? 0,
        owner,
        restored,
      );
    }
  } finally {
    timeline.releaseTarget(owner);
    viewport.finishNavigation(owner);
  }
}
async function loadNavigator(cursor?: string, refresh = false) {
  navigatorController.abort();
  const controller = new AbortController();
  navigatorController = controller;
  if (!refresh) {
    navigatorQuery = { anchor: cursor ? { kind: "before", cursor } : { kind: "latest" }, limit: 5 };
  }
  const previous = navigator.value;
  const query = navigatorQuery;
  navigatorError.value = null;
  try {
    const read = (request: HistoryPageQuery) =>
      props.repository.getHistoryNavigator(selectionId, request, { signal: controller.signal });
    let result = await read(refresh ? { anchor: { kind: "latest" }, limit: 5 } : query);
    if (controller.signal.aborted || navigatorDisposed || props.metadata.id !== selectionId) {
      return;
    }
    if (result.threadId !== selectionId) {
      throw new Error("Navigation belongs to a different conversation");
    }
    if (
      refresh &&
      query.anchor.kind !== "latest" &&
      previous?.historyEpoch === result.historyEpoch
    ) {
      const paged = await read(query);
      if (controller.signal.aborted || navigatorDisposed || props.metadata.id !== selectionId) {
        return;
      }
      if (
        paged.threadId !== selectionId ||
        paged.historyEpoch !== result.historyEpoch ||
        paged.contentRevision !== result.contentRevision
      ) {
        throw new Error("Navigation changed while refreshing, retry to reload it");
      }
      const seen = new Set(paged.turns.map((turn) => `${turn.physicalRolloutId}:${turn.turnId}`));
      result = {
        ...paged,
        turns: [
          ...paged.turns,
          ...result.turns.filter((turn) => !seen.has(`${turn.physicalRolloutId}:${turn.turnId}`)),
        ],
      };
    } else if (refresh && previous?.historyEpoch !== result.historyEpoch) {
      navigatorQuery = { anchor: { kind: "latest" }, limit: 5 };
    }
    if (!controller.signal.aborted && !navigatorDisposed && props.metadata.id === selectionId) {
      viewport.capture();
      navigator.value = result;
      void viewport.settle();
    }
  } catch (error) {
    if (!controller.signal.aborted && !navigatorDisposed) {
      navigatorError.value =
        error instanceof Error ? error.message : "Turn navigation is unavailable";
    }
  }
}
let unsubscribe = () => {};
onMounted(() => {
  const restored = viewport.restoredPosition;
  if (props.targetTurnId) {
    void revealTarget(props.targetTurnId);
  } else if (restored) {
    const [, turnId] = JSON.parse(restored.turnId) as [string, string];
    void revealTarget(turnId, restored);
  } else {
    void latest();
  }
  void loadNavigator();
  unsubscribe = props.repository.subscribe(
    (event) => {
      if (event.type === "session.updated" && event.ids.includes(props.metadata.id)) {
        viewport.latestAvailable.value = !viewport.follow.value || !settings.liveFollow;
        void timeline.refresh().then(() => {
          if (!navigatorDisposed) {
            return loadNavigator(undefined, true);
          }
          return undefined;
        });
      }
    },
    { threadId: selectionId },
  );
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
  inspectionDisposed = true;
  inspectionAction += 1;
  inspectionOpener = null;
  unsubscribe();
  timeline.dispose();
  navigatorController.abort();
  navigatorDisposed = true;
});
</script>

<template>
  <section ref="historyWorkbench" class="progressive-workbench">
    <header class="conversation-heading">
      <h1 class="theme-display">{{ metadata.title }}</h1>
      <p v-if="timeline.error.value" role="status">
        {{ timeline.error.value }}
        <button type="button" @click="timeline.refresh()">Retry history</button>
      </p>
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
    <p v-if="navigatorError" role="status">
      {{ navigatorError }}
      <button
        type="button"
        @click="
          loadNavigator(
            navigatorQuery.anchor.kind === 'before' ? navigatorQuery.anchor.cursor : undefined,
          )
        "
      >
        Retry navigation
      </button>
    </p>
    <div class="history-navigation">
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
    </div>
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
      @scroll.passive="readScroll"
      @wheel.passive="readInput"
      @touchstart.passive="readInput"
      @touchmove.passive="readInput"
      @touchend.passive="readInput"
      @touchcancel.passive="readInput"
      @keydown.capture="readInput"
      @pointerdown.capture="readInput"
    >
      <div class="history-load">
        <button v-if="timeline.canLoadBefore.value" type="button" @click="timeline.loadBefore()">
          Load older turns
        </button>
      </div>
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
          :data-anchor-source="
            JSON.stringify([
              metadata.id,
              entry.window.physicalRolloutId,
              entry.window.turnId,
              entry.window.historyEpoch,
            ])
          "
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
    <div class="history-actions" @pointerdown.capture="readInput" @keydown.capture="readInput">
      <div class="history-status" :title="historyStatuses.join(' ')">
        <span v-for="status in historyStatuses" :key="status" role="status">{{ status }} </span>
      </div>
      <button
        v-if="viewport.latestAvailable.value || !viewport.follow.value"
        class="history-latest"
        type="button"
        @click="latest"
      >
        Latest content
      </button>
    </div>
    <ConversationInspector
      v-if="inspection"
      :record="inspection"
      :loading="false"
      :error="null"
      @close="closeInspection"
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
  scroll-padding-block: 0.5rem;
}
.history-navigation {
  flex: none;
  block-size: 3.5rem;
  min-width: 0;
}
.history-navigation nav {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 100%;
  padding-inline: 0.5rem;
  overflow-x: auto;
  white-space: nowrap;
}
.history-navigation nav > * {
  flex: none;
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
.history-actions {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  min-height: 2rem;
}
.history-status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.history-latest {
  flex: none;
}
.history-gap {
  padding: 0.75rem;
  border-block: 1px dashed currentColor;
}
</style>
