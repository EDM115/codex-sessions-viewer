import { computed, onScopeDispose, readonly, ref } from "vue";

export type ClipboardState = "default" | "error" | "success";

export function useClipboard(resetAfterMs = 2_500) {
  const state = ref<ClipboardState>("default");
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  function clearReset(): void {
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  }

  function finish(next: Exclude<ClipboardState, "default">): void {
    clearReset();
    state.value = next;
    if (next === "success") {
      resetTimer = setTimeout(() => {
        state.value = "default";
        resetTimer = null;
      }, resetAfterMs);
    }
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      finish("success");
      return true;
    } catch {
      finish("error");
      return false;
    }
  }

  const canCopyImage = computed(
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.write === "function" &&
      typeof ClipboardItem !== "undefined",
  );

  async function copyImage(blob: Blob): Promise<boolean> {
    if (!canCopyImage.value) {
      finish("error");
      return false;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      finish("success");
      return true;
    } catch {
      finish("error");
      return false;
    }
  }

  onScopeDispose(clearReset);

  return {
    canCopyImage,
    copyImage,
    copyText,
    fail: () => finish("error"),
    reset: () => {
      clearReset();
      state.value = "default";
    },
    state: readonly(state),
  };
}
