<script setup lang="ts">
import { PhArrowLeft, PhArrowSquareOut, PhX } from "@phosphor-icons/vue";

import { recentChunkCursor } from "#shared/timeline/conversation.ts";
import type { ConversationSummary, TurnNavigatorItem } from "#shared/types/conversation.ts";
import type { CatalogSessionMetadata, LibraryEntry } from "#shared/types/library.ts";
import type { RepositoryMode, TurnChunk } from "#shared/types/repository.ts";
import { createConversationRepository } from "~/repositories/index.ts";
import type { RepositoryRequester } from "~/repositories/live.ts";

const props = defineProps<{
  parentId: string;
  selectedId: string | null;
  mode: RepositoryMode;
}>();
const emit = defineEmits<{ close: []; select: [sessionId: string | null] }>();
const headingId = useId();
const requestFetch = useRequestFetch();
const requester: RepositoryRequester = (path, options = {}) =>
  requestFetch<unknown, string, "get" | "post" | "delete">(path, {
    method: options.method === "POST" ? "post" : options.method === "DELETE" ? "delete" : "get",
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
  });
const repository = computed(() => createConversationRepository(props.mode, requester));
const items = shallowRef<LibraryEntry[]>([]);
const nextCursor = ref<string | null>(null);
const total = ref(0);
const listLoading = ref(false);
const listError = ref<string | null>(null);
const transcriptLoading = ref(false);
const transcriptError = ref<string | null>(null);
const transcript = shallowRef<
  | {
      kind: "legacy";
      summary: ConversationSummary;
      navigator: TurnNavigatorItem[];
      chunk: TurnChunk;
    }
  | { kind: "progressive"; metadata: CatalogSessionMetadata }
  | null
>(null);
let transcriptController: AbortController | null = null;
let listVersion = 0;
let transcriptVersion = 0;
let retryAppend = false;
let loadedPages = 1;
let refreshQueued = false;
let disposed = false;
let stopSubscription: () => void = () => undefined;

const selectedTitle = computed(() => {
  const item = items.value.find((entry) => entry.id === props.selectedId);
  return (
    (transcript.value?.kind === "progressive"
      ? transcript.value.metadata.title
      : transcript.value?.summary.title) ??
    item?.title ??
    "Subagent"
  );
});
const selectedAgent = computed(
  () => items.value.find((item) => item.id === props.selectedId)?.agent,
);

async function loadList(append = false): Promise<void> {
  const version = ++listVersion;
  const cursor = append ? nextCursor.value : null;
  retryAppend = append;
  listLoading.value = true;
  listError.value = null;
  try {
    const source = repository.value;
    const parentThreadId = props.parentId;
    const refreshedItems: LibraryEntry[] = [];
    let page;
    let pageCursor = cursor;
    // oxlint-disable no-await-in-loop -- Each refreshed page depends on the previous response's cursor.
    for (let index = 0; index < (append ? 1 : loadedPages); index++) {
      page = await source.listSessions({
        scope: "active",
        parentThreadId,
        limit: 20,
        ...(pageCursor === null ? {} : { cursor: pageCursor }),
      });
      if (version !== listVersion) {
        return;
      }
      refreshedItems.push(...page.items);
      pageCursor = page.nextCursor;
      if (pageCursor === null) {
        break;
      }
    }
    // oxlint-enable no-await-in-loop
    if (version !== listVersion || page === undefined) {
      return;
    }
    items.value = append
      ? [...new Map([...items.value, ...refreshedItems].map((item) => [item.id, item])).values()]
      : refreshedItems;
    if (append) {
      loadedPages++;
    }
    nextCursor.value = page.nextCursor;
    total.value = page.total;
  } catch (error) {
    if (version === listVersion) {
      listError.value = error instanceof Error ? error.message : "Unable to load subagents.";
    }
  } finally {
    if (version === listVersion) {
      listLoading.value = false;
      if (refreshQueued && !disposed) {
        refreshQueued = false;
        void loadList();
      }
    }
  }
}

async function loadTranscript(): Promise<void> {
  const version = ++transcriptVersion;
  transcriptController?.abort();
  transcriptController = new AbortController();
  const id = props.selectedId;
  transcript.value = null;
  transcriptError.value = null;
  transcriptLoading.value = id !== null;
  if (id === null) {
    return;
  }
  const source = repository.value;
  try {
    if (source.capabilities().progressiveHistory) {
      const metadata = await source.getSessionMetadata(id, { signal: transcriptController.signal });
      if (metadata.id !== id) {
        throw new Error("Subagent metadata belongs to a different conversation");
      }
      if (version === transcriptVersion) {
        transcript.value = { kind: "progressive", metadata };
      }
      return;
    }
    const [summary, navigator] = await Promise.all([
      source.getSession(id),
      source.getTurnNavigator(id),
    ]);
    if (version !== transcriptVersion) {
      return;
    }
    const chunk = await source.getTurns(id, {
      cursor: recentChunkCursor(summary.turnCount),
      limit: 20,
    });
    if (summary.id !== id || chunk.sessionId !== id || chunk.revision !== summary.revision) {
      throw new Error("Subagent transcript changed, reload this conversation");
    }
    if (version === transcriptVersion) {
      transcript.value = { kind: "legacy", summary, navigator, chunk };
    }
  } catch (error) {
    if (version === transcriptVersion) {
      transcriptError.value =
        error instanceof Error ? error.message : "Unable to load this subagent.";
    }
  } finally {
    if (version === transcriptVersion) {
      transcriptLoading.value = false;
    }
  }
}

watch(
  () => [props.parentId, props.mode],
  () => {
    items.value = [];
    nextCursor.value = null;
    total.value = 0;
    loadedPages = 1;
    refreshQueued = false;
    void loadList();
  },
  { immediate: true },
);
watch(() => [props.parentId, props.selectedId, props.mode], loadTranscript, { immediate: true });
onMounted(() => {
  stopSubscription = watch(
    repository,
    (source, _previous, onCleanup) => {
      onCleanup(
        source.subscribe((event) => {
          if (event.type === "library.updated") {
            if (listLoading.value) {
              refreshQueued = true;
            } else {
              void loadList();
            }
          }
        }),
      );
    },
    { immediate: true },
  );
});
onBeforeUnmount(() => {
  disposed = true;
  stopSubscription();
  listVersion++;
  transcriptVersion++;
  transcriptController?.abort();
});
</script>

<template>
  <aside class="subagent-panel" :aria-labelledby="headingId">
    <header class="subagent-panel__header">
      <UiIconButton
        v-if="selectedId !== null"
        label="Back to subagents"
        @click="emit('select', null)"
      >
        <PhArrowLeft :size="18" aria-hidden="true" />
      </UiIconButton>
      <h2 :id="headingId">{{ selectedId === null ? "Subagents" : selectedTitle }}</h2>
      <NuxtLink
        v-if="selectedId !== null"
        class="subagent-panel__full interactive-control"
        :to="`/session/${encodeURIComponent(selectedId)}`"
        :prefetch="false"
        aria-label="Open subagent as a full session"
      >
        <PhArrowSquareOut :size="18" aria-hidden="true" />
      </NuxtLink>
      <UiIconButton label="Close subagents" @click="emit('close')">
        <PhX :size="18" aria-hidden="true" />
      </UiIconButton>
    </header>
    <div v-if="selectedId === null" class="subagent-panel__list" :aria-busy="listLoading">
      <p v-if="!listLoading && !listError" role="status">{{ total }} subagents</p>
      <ul v-if="items.length">
        <li v-for="item in items" :key="item.id">
          <button
            class="subagent-panel__item interactive-control"
            type="button"
            @click="emit('select', item.id)"
          >
            <strong>{{ item.title }}</strong>
            <span v-if="item.agent?.name && item.agent.name !== item.title">{{
              item.agent.name
            }}</span>
            <span v-if="item.agent?.role">{{ item.agent.role }}</span>
            <span v-if="item.agent?.path">{{ item.agent.path }}</span>
          </button>
        </li>
      </ul>
      <p v-if="listLoading" role="status">Loading subagents…</p>
      <div v-else-if="listError" role="alert">
        <p>{{ listError }}</p>
        <UiButton @click="loadList(retryAppend)">Retry loading subagents</UiButton>
      </div>
      <p v-else-if="items.length === 0">No associated subagent sessions.</p>
      <UiButton
        v-if="nextCursor && !listError"
        :state="listLoading ? 'loading' : 'default'"
        @click="loadList(true)"
        >Load more subagents</UiButton
      >
    </div>
    <div v-else class="subagent-panel__transcript" :aria-busy="transcriptLoading">
      <p v-if="transcriptLoading" class="subagent-panel__message" role="status">
        Loading subagent conversation…
      </p>
      <div v-else-if="transcriptError" class="subagent-panel__message" role="alert">
        <p>{{ transcriptError }}</p>
        <UiButton @click="loadTranscript">Retry loading conversation</UiButton>
      </div>
      <ConversationView
        v-else-if="transcript?.kind === 'legacy'"
        :key="transcript.summary.id"
        embedded
        :summary="transcript.summary"
        :navigator="transcript.navigator"
        :initial-chunk="transcript.chunk"
        :initial-target-turn-id="null"
        :mode="mode"
        @open-child="emit('select', $event)"
      />
      <ConversationProgressiveConversationView
        v-else-if="transcript?.kind === 'progressive'"
        :key="transcript.metadata.id"
        :metadata="transcript.metadata"
        :repository="repository"
        :target-turn-id="null"
        @open-child="emit('select', $event)"
      />
      <p v-if="selectedAgent?.role" class="subagent-panel__identity">
        {{ selectedAgent.name ?? selectedTitle }} · {{ selectedAgent.role }}
      </p>
    </div>
  </aside>
</template>

<style scoped>
.subagent-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border-inline-start: 1px solid var(--color-border);
  background: var(--color-surface);
}
.subagent-panel__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
.subagent-panel__header h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 1rem;
  overflow-wrap: anywhere;
}
.subagent-panel__full {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.75rem;
  min-height: 2.75rem;
}
.subagent-panel__list {
  overflow: auto;
  padding: 1rem;
}
.subagent-panel__list ul {
  display: grid;
  gap: 0.5rem;
  padding: 0;
  list-style: none;
}
.subagent-panel__item {
  display: grid;
  gap: 0.35rem;
  width: 100%;
  padding: 0.75rem;
  text-align: start;
  overflow-wrap: anywhere;
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
}
.subagent-panel__item span {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.subagent-panel__transcript {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.subagent-panel__message {
  padding: 1rem;
}
@media (max-width: 760px) {
  .subagent-panel {
    border-inline-start: 0;
    border-top: 1px solid var(--color-border);
  }
}
</style>
