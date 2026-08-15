<script setup lang="ts">
import { PhArrowRight, PhLockKey, PhSidebarSimple } from "@phosphor-icons/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { ConversationScope, ConversationSummary } from "#shared/types/conversation.ts";
import type {
  RepositoryMode,
  RepositoryRequestOptions,
  SearchHit,
  SearchQuery,
  SessionListQuery,
  ViewerRuntimeStatus,
} from "#shared/types/repository.ts";
import { viewerRuntimeStatusSchema } from "#shared/types/repository.ts";

import { createConversationRepository } from "../../repositories/index.ts";
import type { RepositoryRequester } from "../../repositories/live.ts";
import UiIconButton from "../ui/UiIconButton.vue";
import LibraryPreparationState from "./LibraryPreparationState.vue";
import LibrarySidebar from "./LibrarySidebar.vue";

interface LibraryPayload {
  counts: Record<ConversationScope, number>;
  hits: SearchHit[];
  items: ConversationSummary[];
  nextCursor: string | null;
  runtimeStatus: ViewerRuntimeStatus;
  total: number;
}

const route = useRoute();
const router = useRouter();
const runtimeConfig = useRuntimeConfig();
const requestFetch = useRequestFetch() as unknown as (
  path: string,
  options: { signal?: AbortSignal },
) => Promise<unknown>;
const mode: RepositoryMode = runtimeConfig.public.viewerMode === "static" ? "static" : "live";
const searchExactTurns = mode === "live" || runtimeConfig.public.pagefindEnabled;
const requester: RepositoryRequester = (path, options = {}) =>
  requestFetch(path, { signal: options.signal }) as Promise<unknown>;
const repository = createConversationRepository(mode, requester);

function stringQuery(name: string): string {
  const value = route.query[name];
  return typeof value === "string" ? value : "";
}

const scope = computed<ConversationScope>(() =>
  route.query.scope === "archived" ? "archived" : "active",
);
const query = computed(() => stringQuery("q"));
const model = computed(() => stringQuery("model"));
const cwd = computed(() => stringQuery("cwd"));
const tool = computed(() => stringQuery("tool"));
const hasMedia = computed(() => route.query.media === "1");
const selectedId = computed(() => null);

function listQuery(cursor?: string): SessionListQuery {
  return {
    scope: scope.value,
    limit: 100,
    ...(cursor === undefined ? {} : { cursor }),
    ...(query.value.trim() === "" ? {} : { query: query.value.trim() }),
    ...(model.value === "" ? {} : { model: model.value }),
    ...(cwd.value === "" ? {} : { cwd: cwd.value }),
    ...(tool.value === "" ? {} : { tool: tool.value }),
    ...(hasMedia.value ? { hasMedia: true } : {}),
  };
}

function searchQuery(cursor?: string): SearchQuery {
  return { ...listQuery(cursor), query: query.value.trim() };
}

async function loadPayload(
  options: RepositoryRequestOptions = {},
  cursor?: string,
): Promise<LibraryPayload> {
  const searching = query.value.trim() !== "";
  const [active, archived, result, runtimeStatus] = await Promise.all([
    repository.listSessions({ scope: "active", limit: 1 }, options),
    repository.listSessions({ scope: "archived", limit: 1 }, options),
    searching && searchExactTurns
      ? repository.search(searchQuery(cursor), options)
      : repository.listSessions(listQuery(cursor), options),
    mode === "live"
      ? requester("/api/status", options).then((value) => viewerRuntimeStatusSchema.parse(value))
      : Promise.resolve<ViewerRuntimeStatus>({ state: "ready", message: null }),
  ]);
  return {
    counts: { active: active.total, archived: archived.total },
    hits: searching && searchExactTurns ? (result.items as SearchHit[]) : [],
    items: searching && searchExactTurns ? [] : (result.items as ConversationSummary[]),
    nextCursor: result.nextCursor,
    runtimeStatus,
    total: result.total,
  };
}

const initial = await useAsyncData("library-initial", () => loadPayload(), {
  server: mode === "static",
  immediate: mode === "static",
});
const counts = reactive<Record<ConversationScope, number>>(
  initial.data.value?.counts ?? { active: 0, archived: 0 },
);
const items = ref(initial.data.value?.items ?? []);
const hits = ref(initial.data.value?.hits ?? []);
const settledTotal = ref(initial.data.value?.total ?? 0);
const nextCursor = ref(initial.data.value?.nextCursor ?? null);
const runtimeStatus = ref<ViewerRuntimeStatus>(
  initial.data.value?.runtimeStatus ??
    (mode === "live" ? { state: "preparing", message: null } : { state: "ready", message: null }),
);
const loading = ref(mode === "live" || initial.status.value === "pending");
const error = ref<string | null>(
  runtimeStatus.value.state === "error"
    ? runtimeStatus.value.message
    : (initial.error.value?.message ?? null),
);
const sidebarOpen = ref(false);
const workbench = ref<HTMLElement | null>(null);
const hasSettledContent = computed(
  () => counts.active + counts.archived > 0 || items.value.length > 0 || hits.value.length > 0,
);
let timer: ReturnType<typeof setTimeout> | null = null;
let readinessTimer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;
let unsubscribe: () => void = () => undefined;

function applyPayload(payload: LibraryPayload, append = false): void {
  counts.active = payload.counts.active;
  counts.archived = payload.counts.archived;
  items.value = append ? [...items.value, ...payload.items] : payload.items;
  hits.value = append ? [...hits.value, ...payload.hits] : payload.hits;
  nextCursor.value = payload.nextCursor;
  runtimeStatus.value = payload.runtimeStatus;
  settledTotal.value = payload.total;
  if (payload.runtimeStatus.state === "error") {
    error.value = payload.runtimeStatus.message ?? "The local session cache could not be prepared.";
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The local session source could not be read.";
}

async function refresh(append = false): Promise<void> {
  controller?.abort();
  const requestController = new AbortController();
  controller = requestController;
  loading.value = true;
  error.value = null;
  try {
    const payload = await loadPayload(
      { signal: requestController.signal },
      append ? (nextCursor.value ?? undefined) : undefined,
    );
    if (!requestController.signal.aborted) {
      applyPayload(payload, append);
    }
  } catch (reason) {
    if (!(reason instanceof Error && reason.name === "AbortError")) {
      error.value = errorMessage(reason);
    }
  } finally {
    if (controller === requestController) {
      loading.value = false;
      controller = null;
    }
  }
}

async function closeSidebar(): Promise<void> {
  sidebarOpen.value = false;
  await nextTick();
  workbench.value?.querySelector<HTMLButtonElement>(".library-workbench__opener button")?.focus();
}

async function pollReadiness(): Promise<void> {
  if (mode !== "live" || runtimeStatus.value.state !== "preparing") {
    return;
  }
  try {
    runtimeStatus.value = viewerRuntimeStatusSchema.parse(await requester("/api/status"));
    if (runtimeStatus.value.state === "ready") {
      await refresh();
      return;
    }
    if (runtimeStatus.value.state === "error") {
      error.value = runtimeStatus.value.message ?? "The local session cache could not be prepared.";
      return;
    }
  } catch (reason) {
    error.value = errorMessage(reason);
    return;
  }
  readinessTimer = setTimeout(() => void pollReadiness(), 750);
}

function scheduleRefresh(): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
  controller?.abort();
  timer = setTimeout(() => void refresh(), query.value.trim() === "" ? 0 : 250);
}

function updateQuery(name: string, value: string | boolean): void {
  const next = { ...route.query };
  if (value === "" || value === false || (name === "scope" && value === "active")) {
    delete next[name];
  } else {
    next[name] = typeof value === "boolean" ? "1" : value;
  }
  void router.replace({ query: next });
}

watch([scope, query, model, cwd, tool, hasMedia], scheduleRefresh);

onMounted(() => {
  unsubscribe = repository.subscribe((event) => {
    if (event.type === "library.updated") {
      scheduleRefresh();
    }
  });
  if (mode === "live") {
    void refresh();
  }
  void pollReadiness();
});

onBeforeUnmount(() => {
  unsubscribe();
  controller?.abort();
  if (timer !== null) {
    clearTimeout(timer);
  }
  if (readinessTimer !== null) {
    clearTimeout(readinessTimer);
  }
});
</script>

<template>
  <div ref="workbench" class="library-workbench" @keydown.esc="closeSidebar">
    <UiIconButton
      class="library-workbench__opener"
      label="Open session library"
      controls="session-library-panel"
      :expanded="sidebarOpen"
      @click="sidebarOpen = true"
    >
      <PhSidebarSimple :size="21" weight="regular" aria-hidden="true" />
    </UiIconButton>
    <button
      v-if="sidebarOpen"
      class="library-workbench__scrim"
      type="button"
      aria-label="Close session library"
      @click="closeSidebar"
    />
    <div
      id="session-library-panel"
      class="library-workbench__rail"
      :class="sidebarOpen ? 'is-open' : null"
    >
      <LibrarySidebar
        :scope="scope"
        :counts="counts"
        :query="query"
        :model="model"
        :cwd="cwd"
        :tool="tool"
        :has-media="hasMedia"
        :items="items"
        :hits="hits"
        :loading="loading || (runtimeStatus.state === 'preparing' && !hasSettledContent)"
        :error="error"
        :settled-total="settledTotal"
        :next-cursor="nextCursor"
        :mode="mode"
        :search-exact-turns="searchExactTurns"
        :selected-id="selectedId"
        @close="closeSidebar"
        @load-more="refresh(true)"
        @retry="refresh()"
        @update:scope="updateQuery('scope', $event)"
        @update:query="updateQuery('q', $event)"
        @update:model="updateQuery('model', $event)"
        @update:cwd="updateQuery('cwd', $event)"
        @update:tool="updateQuery('tool', $event)"
        @update:has-media="updateQuery('media', $event)"
      />
    </div>

    <main class="library-workbench__canvas">
      <LibraryPreparationState
        v-if="runtimeStatus.state !== 'ready' && !hasSettledContent"
        :state="runtimeStatus.state"
        :message="runtimeStatus.message"
      />
      <section v-else class="library-intro" aria-labelledby="library-heading">
        <p
          v-if="runtimeStatus.state === 'preparing'"
          class="library-preparation-note"
          role="status"
        >
          <span class="mode-indicator is-live" aria-hidden="true" /> Refreshing the local archive in
          the background…
        </p>
        <p
          v-else-if="runtimeStatus.state === 'error'"
          class="library-preparation-note is-error"
          role="alert"
        >
          <PhLockKey :size="17" weight="regular" aria-hidden="true" />
          {{ runtimeStatus.message ?? "The local session cache could not be prepared." }}
        </p>
        <p class="library-intro__kicker">A private instrument for your local work</p>
        <h1 id="library-heading" class="library-intro__title theme-display">
          Find the exact conversation, then return to the exact turn.
        </h1>
        <p class="library-intro__lead">
          Browse normalized Codex sessions without writing to the files that produced them. Search
          prompts, responses, paths, models, and tools from one locally served archive.
        </p>
        <a class="library-intro__action" href="#session-library-panel">
          Browse {{ counts.active + counts.archived }} sessions
          <PhArrowRight :size="18" weight="regular" aria-hidden="true" />
        </a>
      </section>

      <section class="library-ledger" aria-label="Archive summary">
        <div>
          <span class="tabular">{{ counts.active }}</span
          ><span>Active</span>
        </div>
        <div>
          <span class="tabular">{{ counts.archived }}</span
          ><span>Archived</span>
        </div>
        <div>
          <span>{{ searchExactTurns ? "Exact-turn" : "Metadata" }}</span
          ><span>Search boundary</span>
        </div>
      </section>

      <footer class="library-status-close">
        <p>
          <PhLockKey :size="17" weight="regular" aria-hidden="true" /> Codex source files remain
          read-only.
        </p>
        <p>
          <span
            class="mode-indicator"
            :class="mode === 'live' ? 'is-live' : null"
            aria-hidden="true"
          />
          {{ mode === "live" ? "Live on loopback" : "Static export" }}
        </p>
      </footer>
    </main>
  </div>
</template>
