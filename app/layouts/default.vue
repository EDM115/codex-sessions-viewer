<script setup lang="ts">
import { PhGear, PhHouse } from "@phosphor-icons/vue";

import LibraryWorkspace from "../components/library/LibraryWorkspace.vue";
import UiIconLink from "../components/ui/UiIconLink.vue";
import { usePresentationSettings } from "../composables/usePresentationSettings.ts";

const route = useRoute();
const { settings } = usePresentationSettings();

const context = computed(() =>
  route.path === "/settings"
    ? "Settings"
    : route.path.startsWith("/session/")
      ? "Conversation"
      : "Library",
);
</script>

<template>
  <!-- Direction contract: left library rail -> focused work canvas -> compact global actions. -->
  <div
    class="app-root"
    :data-theme="settings.theme"
    :data-wrap-code="settings.wrapCode ? 'true' : 'false'"
  >
    <a class="skip-link" href="#main-content">Skip to content</a>
    <header class="app-chrome">
      <a class="app-chrome__brand" href="/" aria-label="Codex Sessions Viewer home">
        <span class="app-chrome__sigil" aria-hidden="true">C</span>
        <span>Codex Sessions Viewer</span>
      </a>
      <p class="app-chrome__context">{{ context }}</p>
      <nav class="app-chrome__actions" aria-label="Application">
        <UiIconLink v-if="route.path !== '/'" href="/" label="Open session library">
          <PhHouse :size="20" weight="regular" aria-hidden="true" />
        </UiIconLink>
        <UiIconLink
          v-if="route.path !== '/settings'"
          href="/settings"
          label="Open Settings"
          tooltip="Settings"
        >
          <PhGear :size="20" weight="regular" aria-hidden="true" />
        </UiIconLink>
      </nav>
    </header>
    <div id="main-content" class="app-content">
      <LibraryWorkspace v-if="route.path === '/' || route.path.startsWith('/session/')">
        <slot />
      </LibraryWorkspace>
      <slot v-else />
    </div>
  </div>
</template>
