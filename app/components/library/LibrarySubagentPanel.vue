<script setup lang="ts">
import { PhArrowLeft, PhArrowSquareOut, PhX } from "@phosphor-icons/vue";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from "vue";

import { recentChunkCursor } from "#shared/timeline/conversation.ts";
import type { ConversationSummary, TurnNavigatorItem } from "#shared/types/conversation.ts";
import type { ConversationListItem } from "#shared/types/library.ts";
import type { RepositoryMode, TurnChunk } from "#shared/types/repository.ts";

import { createConversationRepository } from "../../repositories/index.ts";
import type { RepositoryRequester } from "../../repositories/live.ts";
import ConversationView from "../conversation/ConversationView.vue";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";

const props = defineProps<{
  parentId: string;
  selectedId: string | null;
  mode: RepositoryMode;
}>();
const emit = defineEmits<{ close: []; select: [sessionId: string | null] }>();
const headingId = useId();
const requestFetch = useRequestFetch() as unknown as (
  path: string,
  options: { signal?: AbortSignal },
) => Promise<unknown>;
const requester: RepositoryRequester = (path, options = {}) =>
  requestFetch(path, { signal: options.signal }) as Promise<unknown>;
const repository = computed(() => createConversationRepository(props.mode, requester));
const items = shallowRef<ConversationListItem[]>([]);
const nextCursor = ref<string | null>(null);
const total = ref(0);
const listLoading = ref(false);
const listError = ref<string | null>(null);
const transcriptLoading = ref(false);
const transcriptError = ref<string | null>(null);
const transcript = shallowRef<{
  summary: ConversationSummary;
  navigator: TurnNavigatorItem[];
  chunk: TurnChunk;
} | null>(null);
let listVersion = 0;
let transcriptVersion = 0;
let retryAppend = false;
let loadedPages = 1;
let refreshQueued = false;
let disposed = false;
let stopSubscription: () => void = () => undefined;

const selectedTitle = computed(() => {
  const item = items.value.find((entry) => entry.summary.id === props.selectedId);
  return (
    item?.agentNickname ?? transcript.value?.summary.title ?? item?.summary.title ?? "Subagent"
  );
});

async function loadList(append = false): Promise<void> {
  const version = ++listVersion;
  const cursor = append ? nextCursor.value : null;
  retryAppend = append;
  listLoading.value = true;
  listError.value = null;
  try {
    const source = repository.value;
    const parentThreadId = props.parentId;
    const refreshedItems: ConversationListItem[] = [];
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
      ? [
          ...new Map(
            [...items.value, ...refreshedItems].map((item) => [item.summary.id, item]),
          ).values(),
        ]
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
  const id = props.selectedId;
  transcript.value = null;
  transcriptError.value = null;
  transcriptLoading.value = id !== null;
  if (id === null) {
    return;
  }
  const source = repository.value;
  try {
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
    if (version === transcriptVersion) {
      transcript.value = { summary, navigator, chunk };
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
        <li v-for="item in items" :key="item.summary.id">
          <button
            class="subagent-panel__item interactive-control"
            type="button"
            @click="emit('select', item.summary.id)"
          >
            <strong>{{ item.agentNickname ?? item.summary.title }}</strong>
            <span v-if="item.agentNickname">{{ item.summary.title }}</span>
            <span v-if="item.summary.preview">{{ item.summary.preview }}</span>
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
        v-else-if="transcript"
        :key="transcript.summary.id"
        embedded
        :summary="transcript.summary"
        :navigator="transcript.navigator"
        :initial-chunk="transcript.chunk"
        :initial-target-turn-id="null"
        :mode="mode"
        @open-child="emit('select', $event)"
      />
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
