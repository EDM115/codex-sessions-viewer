<script setup lang="ts">
import { PhLockKey, PhWarningCircle } from "@phosphor-icons/vue";

import type { ViewerRuntimeStatus } from "#shared/types/repository.ts";

import LibrarySkeleton from "./LibrarySkeleton.vue";

defineProps<ViewerRuntimeStatus>();
</script>

<template>
  <section
    class="library-preparation"
    :class="state === 'error' ? 'is-error' : null"
    :role="state === 'error' ? 'alert' : 'status'"
    aria-live="polite"
  >
    <p class="library-intro__kicker">
      {{ state === "error" ? "Preparation stopped" : "Building the local view" }}
    </p>
    <h1 class="library-preparation__title theme-display">
      {{
        state === "error" ? "The archive could not be prepared." : "Preparing your local archive…"
      }}
    </h1>
    <p class="library-preparation__lead">
      {{
        state === "error"
          ? (message ?? "Restart the local viewer after correcting the reported error.")
          : "The page is ready while the viewer reconciles session metadata and cached conversation payloads in the background."
      }}
    </p>
    <LibrarySkeleton v-if="state === 'preparing'" :rows="4" />
    <p class="library-preparation__boundary">
      <PhWarningCircle v-if="state === 'error'" :size="18" weight="regular" aria-hidden="true" />
      <PhLockKey v-else :size="18" weight="regular" aria-hidden="true" />
      Codex source files remain read-only.
    </p>
  </section>
</template>
