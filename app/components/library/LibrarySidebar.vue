<script setup lang="ts">
import { PhFunnel, PhX } from "@phosphor-icons/vue";
import { computed } from "vue";

import type { ConversationScope, ConversationSummary } from "#shared/types/conversation.ts";
import type { SearchHit } from "#shared/types/repository.ts";

import UiButton from "../ui/UiButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiTabs, { type UiTabItem } from "../ui/UiTabs.vue";
import UiTextField from "../ui/UiTextField.vue";
import LibraryEmptyState from "./LibraryEmptyState.vue";
import LibrarySearchResults from "./LibrarySearchResults.vue";
import LibrarySessionList from "./LibrarySessionList.vue";
import LibrarySkeleton from "./LibrarySkeleton.vue";

const props = withDefaults(
  defineProps<{
    counts: Record<ConversationScope, number>;
    cwd: string;
    error: string | null;
    hasMedia: boolean;
    hits: SearchHit[];
    items: ConversationSummary[];
    loading: boolean;
    mode?: "live" | "static";
    model: string;
    nextCursor: string | null;
    query: string;
    scope: ConversationScope;
    searchExactTurns: boolean;
    selectedId?: string | null;
    settledTotal: number;
    tool: string;
  }>(),
  { mode: "live", selectedId: null },
);

const emit = defineEmits<{
  close: [];
  "load-more": [];
  retry: [];
  "update:cwd": [value: string];
  "update:hasMedia": [value: boolean];
  "update:model": [value: string];
  "update:query": [value: string];
  "update:scope": [value: ConversationScope];
  "update:tool": [value: string];
}>();

const tabs = computed<UiTabItem[]>(() => [
  { value: "active", label: "Active", count: props.counts.active },
  { value: "archived", label: "Archived", count: props.counts.archived },
]);
const searching = computed(() => props.query.trim() !== "");
const announcement = computed(() =>
  searching.value
    ? `${props.settledTotal} ${props.settledTotal === 1 ? "result" : "results"} for “${props.query}”`
    : `${props.settledTotal} ${props.settledTotal === 1 ? "session" : "sessions"}`,
);

function updateScope(value: string): void {
  if (value === "active" || value === "archived") {
    emit("update:scope", value);
  }
}

function updateMedia(event: Event): void {
  emit("update:hasMedia", (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <aside class="library-sidebar" aria-label="Session library">
    <header class="library-sidebar__brand">
      <div>
        <p class="library-sidebar__eyebrow">Local archive</p>
        <a class="library-sidebar__wordmark" href="/">Codex Sessions</a>
      </div>
      <UiIconButton
        class="library-sidebar__close"
        label="Close session library"
        @click="emit('close')"
      >
        <PhX :size="20" weight="regular" aria-hidden="true" />
      </UiIconButton>
    </header>

    <div class="library-sidebar__mode">
      <span class="mode-indicator" :class="mode === 'live' ? 'is-live' : null" aria-hidden="true" />
      <span>{{ mode === "live" ? "Watching local Codex files" : "Static read-only export" }}</span>
    </div>

    <UiTextField
      id="library-search"
      :model-value="query"
      label="Search sessions"
      type="search"
      placeholder="Prompt, response, path…"
      helper="Search is scoped to the selected tab."
      @update:model-value="emit('update:query', $event)"
    />

    <UiTabs
      :items="tabs"
      label="Session scope"
      :model-value="scope"
      @update:model-value="updateScope"
    />

    <UiDisclosure
      class="library-sidebar__filters"
      :open="Boolean(model || cwd || tool || hasMedia)"
      label="Refine results"
    >
      <div class="library-filter-grid">
        <UiTextField
          id="library-model"
          :model-value="model"
          label="Model"
          placeholder="gpt-5"
          @update:model-value="emit('update:model', $event)"
        />
        <UiTextField
          id="library-cwd"
          :model-value="cwd"
          label="Working directory"
          placeholder="C:/repo"
          @update:model-value="emit('update:cwd', $event)"
        />
        <UiTextField
          id="library-tool"
          :model-value="tool"
          label="Tool"
          placeholder="exec_command"
          @update:model-value="emit('update:tool', $event)"
        />
        <label class="library-filter-check interactive-control">
          <input type="checkbox" :checked="hasMedia" @change="updateMedia" />
          <span>Has media</span>
        </label>
      </div>
    </UiDisclosure>

    <div class="library-sidebar__results-heading">
      <span>{{ searching ? "Matches" : "Sessions" }}</span>
      <span class="tabular">{{ settledTotal }}</span>
    </div>
    <p class="visually-hidden" aria-live="polite" aria-atomic="true">{{ announcement }}</p>
    <p v-if="searching && !searchExactTurns" class="library-sidebar__boundary">
      <PhFunnel :size="15" weight="regular" aria-hidden="true" /> Transcript search was not included
      in this export; matching session metadata only.
    </p>

    <div class="library-sidebar__scroll-region">
      <LibrarySkeleton v-if="loading" />
      <LibraryEmptyState
        v-else-if="error"
        title="The session source is unavailable"
        :description="error"
        recoverable
        @retry="emit('retry')"
      />
      <LibrarySearchResults
        v-else-if="searching && searchExactTurns && hits.length > 0"
        :hits="hits"
        :query="query"
      />
      <LibrarySessionList v-else-if="items.length > 0" :items="items" :selected-id="selectedId" />
      <LibraryEmptyState
        v-else
        :title="searching ? 'No matching turns' : `No ${scope} sessions`"
        :description="
          searching
            ? 'Try a broader phrase or clear one of the filters.'
            : 'The viewer found no sessions in this scope.'
        "
      />
    </div>

    <UiButton
      v-if="nextCursor && !loading"
      class="library-sidebar__more"
      variant="quiet"
      @click="emit('load-more')"
      >Load more</UiButton
    >
  </aside>
</template>
