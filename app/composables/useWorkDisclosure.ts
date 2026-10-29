import type { MaybeRefOrGetter } from "vue";

import type { DisclosureDefault } from "#shared/types/conversation.ts";

export type WorkDisclosureState = "running" | "completed" | "error" | "cancelled" | "unknown";

/** Persist explicit intent only, source lifecycle updates can still change the default */
export function useWorkDisclosure(
  key: MaybeRefOrGetter<string>,
  state: MaybeRefOrGetter<WorkDisclosureState>,
  preference: MaybeRefOrGetter<DisclosureDefault> = "collapsed",
) {
  const choices = useState<Record<string, boolean>>("work-disclosure-choices", () => ({}));
  const choice = ref<boolean | null>(null);
  const storageKey = computed(() => `codex-sessions-viewer:disclosure:v1:${toValue(key)}`);
  const open = computed(
    () =>
      choice.value ??
      (["running", "cancelled", "error"].includes(toValue(state)) ||
        (toValue(state) !== "completed" && toValue(preference) === "expanded")),
  );
  function hydrate() {
    choice.value = choices.value[storageKey.value] ?? null;
    if (choice.value !== null) {
      return;
    }
    try {
      const stored = localStorage.getItem(storageKey.value);
      if (stored === "true" || stored === "false") {
        choice.value = stored === "true";
      }
    } catch {
      /* Optional storage must not prevent reading */
    }
  }
  onMounted(hydrate);
  watch(storageKey, hydrate);
  function toggle(event: Event) {
    const details = event.currentTarget;
    if (!(details instanceof HTMLDetailsElement)) {
      return;
    }
    if (details.open === open.value) {
      return;
    }
    choice.value = details.open;
    choices.value = Object.fromEntries([
      ...Object.entries(choices.value)
        .filter(([storedKey]) => storedKey !== storageKey.value)
        .slice(-1023),
      [storageKey.value, details.open],
    ]);
    try {
      localStorage.setItem(storageKey.value, String(choice.value));
    } catch {
      /* Optional storage */
    }
  }
  return { open, toggle };
}
