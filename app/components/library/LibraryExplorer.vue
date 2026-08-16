<script setup lang="ts">
import { PhArrowRight, PhLockKey } from "@phosphor-icons/vue";

import { useLibraryWorkspace } from "../../composables/useLibraryWorkspace.ts";
import LibraryPreparationState from "./LibraryPreparationState.vue";

const workspace = useLibraryWorkspace();
</script>

<template>
  <LibraryPreparationState
    v-if="workspace.runtimeStatus.value.state !== 'ready' && !workspace.hasSettledContent.value"
    :state="workspace.runtimeStatus.value.state"
    :message="workspace.runtimeStatus.value.message"
  />
  <section v-else class="library-intro" aria-labelledby="library-heading">
    <p
      v-if="workspace.runtimeStatus.value.state === 'preparing'"
      class="library-preparation-note"
      role="status"
    >
      <span class="mode-indicator is-live" aria-hidden="true" /> Refreshing the local catalog in the
      background…
    </p>
    <p
      v-else-if="workspace.runtimeStatus.value.state === 'error'"
      class="library-preparation-note is-error"
      role="alert"
    >
      <PhLockKey :size="17" weight="regular" aria-hidden="true" />
      {{
        workspace.runtimeStatus.value.message ?? "The local session catalog could not be loaded."
      }}
    </p>
    <p class="library-intro__kicker">A private instrument for your local work</p>
    <h1 id="library-heading" class="library-intro__title theme-display">
      Find the exact conversation, then return to the exact turn.
    </h1>
    <p class="library-intro__lead">
      Browse Codex session metadata immediately. Conversation payloads are prepared from the
      read-only source only when you open or reveal them.
    </p>
    <a class="library-intro__action" href="#session-library-panel">
      Browse {{ workspace.counts.active + workspace.counts.archived }} conversations
      <PhArrowRight :size="18" weight="regular" aria-hidden="true" />
    </a>
  </section>

  <section class="library-ledger" aria-label="Archive summary">
    <div>
      <span class="tabular">{{ workspace.counts.active }}</span
      ><span>Active</span>
    </div>
    <div>
      <span class="tabular">{{ workspace.counts.archived }}</span
      ><span>Archived</span>
    </div>
    <div>
      <span>{{ workspace.searchExactTurns ? "Progressive" : "Exact-turn" }}</span
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
        :class="workspace.mode === 'live' ? 'is-live' : null"
        aria-hidden="true"
      />
      {{ workspace.mode === "live" ? "Live on loopback" : "Static export" }}
    </p>
  </footer>
</template>
