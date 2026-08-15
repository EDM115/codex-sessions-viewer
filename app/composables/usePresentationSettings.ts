import { onMounted, readonly, ref, shallowReactive } from "vue";

import type { DisclosureDefault, ViewerTheme } from "#shared/types/conversation.ts";
import {
  DEFAULT_PRESENTATION_SETTINGS,
  migratePresentationSettings,
  PRESENTATION_SETTINGS_STORAGE_KEY,
  serializePresentationSettings,
  type PresentationSettings,
} from "#shared/types/settings.ts";

const settingsState = shallowReactive<PresentationSettings>({
  ...DEFAULT_PRESENTATION_SETTINGS,
});
const hydratedState = ref(false);
const readonlySettings = readonly(settingsState);
const readonlyHydrated = readonly(hydratedState);

function readStoredSettings(): PresentationSettings {
  try {
    const stored = window.localStorage.getItem(PRESENTATION_SETTINGS_STORAGE_KEY);
    return migratePresentationSettings(stored === null ? undefined : JSON.parse(stored));
  } catch {
    return { ...DEFAULT_PRESENTATION_SETTINGS };
  }
}

function persistSettings(): void {
  if (!hydratedState.value) {
    return;
  }
  try {
    window.localStorage.setItem(
      PRESENTATION_SETTINGS_STORAGE_KEY,
      JSON.stringify(serializePresentationSettings(settingsState)),
    );
  } catch {
    // Presentation preferences are optional; private browsing and full storage must not break UI.
  }
}

function updateSetting<Key extends keyof PresentationSettings>(
  key: Key,
  value: PresentationSettings[Key],
): void {
  settingsState[key] = value;
  persistSettings();
}

function hydratePresentationSettings(): void {
  if (hydratedState.value) {
    return;
  }
  Object.assign(settingsState, readStoredSettings());
  hydratedState.value = true;
}

export function usePresentationSettings() {
  onMounted(hydratePresentationSettings);

  return {
    settings: readonlySettings,
    hydrated: readonlyHydrated,
    setTheme: (theme: ViewerTheme) => updateSetting("theme", theme),
    setToolCallsDefault: (value: DisclosureDefault) => updateSetting("toolCallsDefault", value),
    setReasoningDefault: (value: DisclosureDefault) => updateSetting("reasoningDefault", value),
    setTimestampFormat: (value: PresentationSettings["timestampFormat"]) =>
      updateSetting("timestampFormat", value),
    setWrapCode: (value: boolean) => updateSetting("wrapCode", value),
    setLiveFollow: (value: boolean) => updateSetting("liveFollow", value),
    setTurnMinimap: (value: boolean) => updateSetting("turnMinimap", value),
  } as const;
}
