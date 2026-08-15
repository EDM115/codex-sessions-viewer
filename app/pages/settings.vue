<script setup lang="ts">
import { computed, ref } from "vue";
import * as z from "zod";

import { viewerDiagnosticSchema } from "#shared/types/diagnostics.ts";
import { repositoryCapabilitiesForMode, type RepositoryMode } from "#shared/types/repository.ts";
import { serverViewerSettingsSchema } from "#shared/types/settings.ts";

import SettingsPanel from "../components/settings/SettingsPanel.vue";
import { usePresentationSettings } from "../composables/usePresentationSettings.ts";

const settingsPayloadSchema = z.strictObject({
  server: serverViewerSettingsSchema,
  diagnostics: z.array(viewerDiagnosticSchema),
});

const runtimeConfig = useRuntimeConfig();
const requestFetch = useRequestFetch();
const mode: RepositoryMode = runtimeConfig.public.viewerMode === "static" ? "static" : "live";
const capabilities = repositoryCapabilitiesForMode(mode);
const runtimeSettings = await useAsyncData("viewer-runtime-settings", async () =>
  mode === "live" ? settingsPayloadSchema.parse(await requestFetch("/api/settings")) : null,
);
const server = ref(runtimeSettings.data.value?.server ?? null);
const diagnostics = computed(() => runtimeSettings.data.value?.diagnostics ?? []);
const codexHome = ref(server.value?.codexHome ?? "Embedded at export time");
const saveState = ref<"default" | "loading" | "error" | "success">("default");
const pageError = computed(() => runtimeSettings.error.value?.message ?? null);
const {
  settings,
  setLiveFollow,
  setReasoningDefault,
  setTheme,
  setTimestampFormat,
  setToolCallsDefault,
  setTurnMinimap,
  setWrapCode,
} = usePresentationSettings();

useHead({ title: "Settings · Codex Sessions Viewer" });

async function saveCodexHome(): Promise<void> {
  if (server.value === null || !capabilities.serverSettings) {
    return;
  }
  saveState.value = "loading";
  try {
    const payload = settingsPayloadSchema.parse(
      await $fetch("/api/settings", {
        method: "PUT",
        body: { ...server.value, codexHome: codexHome.value },
      }),
    );
    server.value = payload.server;
    codexHome.value = payload.server.codexHome;
    runtimeSettings.data.value = payload;
    saveState.value = "success";
  } catch {
    saveState.value = "error";
  }
}
</script>

<template>
  <main class="settings-page">
    <p v-if="pageError" class="settings-page__error" role="alert">
      Live settings could not be loaded: {{ pageError }}
    </p>
    <SettingsPanel
      :mode="mode"
      :codex-home="codexHome"
      :fetch-favicons="server?.fetchFavicons ?? null"
      :diagnostics="diagnostics"
      :capabilities="capabilities"
      :pagefind-enabled="runtimeConfig.public.pagefindEnabled"
      :presentation="settings"
      :save-state="saveState"
      @update:codex-home="codexHome = $event"
      @save-codex-home="saveCodexHome"
      @update:theme="setTheme"
      @update:tool-default="setToolCallsDefault"
      @update:reasoning-default="setReasoningDefault"
      @update:timestamp-format="setTimestampFormat"
      @update:wrap-code="setWrapCode"
      @update:live-follow="setLiveFollow"
      @update:turn-minimap="setTurnMinimap"
    />
  </main>
</template>
