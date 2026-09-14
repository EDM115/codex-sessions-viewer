import { computed } from "vue";

import { usePresentationSettings } from "../../composables/usePresentationSettings.ts";

export function useContentTheme() {
  const { settings } = usePresentationSettings();
  // The layout applies this setting to .app-root; html retains the dark CSS default.
  return computed<"dark" | "light">(() => (settings.theme === "midnight-glass" ? "dark" : "light"));
}
