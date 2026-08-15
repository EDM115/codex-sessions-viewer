<script setup lang="ts">
import {
  PhArrowsOut,
  PhArrowCounterClockwise,
  PhCheck,
  PhCopy,
  PhDownloadSimple,
  PhMagnifyingGlassMinus,
  PhMagnifyingGlassPlus,
  PhResize,
  PhWarning,
  PhX,
} from "@phosphor-icons/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { useClipboard } from "../../composables/useClipboard.ts";
import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import UiIconButton from "../ui/UiIconButton.vue";

const props = withDefaults(
  defineProps<{
    background?: HTMLElement;
    item: MediaViewerItem;
  }>(),
  { background: undefined },
);
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const scale = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const fitted = ref(true);
const actionError = ref<string | null>(null);
const pointers = new Map<number, { x: number; y: number }>();
const { canCopyImage, copyImage, fail: failCopy, state: copyState } = useClipboard();
let previousBackgroundInert = false;
let pinchDistance = 0;
let pinchScale = 1;

const source = computed(() =>
  props.item.kind === "image"
    ? props.item.src
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.item.svg)}`,
);
const contentStyle = computed(() => ({
  transform: `translate3d(${offsetX.value}px, ${offsetY.value}px, 0) scale(${scale.value})`,
}));
const copyLabel = computed(() => {
  if (!canCopyImage.value) {
    return "Copy image unavailable";
  }
  return copyState.value === "success"
    ? "Copied: Copy image"
    : props.item.kind === "svg"
      ? "Copy diagram as PNG"
      : "Copy image";
});
const clipboardTooltip = computed(() =>
  canCopyImage.value ? copyLabel.value : "Image clipboard is unavailable in this browser.",
);

function clampScale(value: number): number {
  return Math.min(8, Math.max(0.25, value));
}

function zoom(delta: number): void {
  fitted.value = false;
  scale.value = clampScale(Math.round((scale.value + delta) * 100) / 100);
}

function fit(): void {
  fitted.value = true;
  scale.value = 1;
  offsetX.value = 0;
  offsetY.value = 0;
}

function originalSize(): void {
  fitted.value = false;
  scale.value = 1;
  offsetX.value = 0;
  offsetY.value = 0;
}

function close(): void {
  emit("close");
}

function handleBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) {
    close();
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
}

function handleWheel(event: WheelEvent): void {
  event.preventDefault();
  zoom(event.deltaY < 0 ? 0.25 : -0.25);
}

function pointerDistance(): number {
  const [first, second] = [...pointers.values()];
  return first === undefined || second === undefined
    ? 0
    : Math.hypot(second.x - first.x, second.y - first.y);
}

function handlePointerDown(event: PointerEvent): void {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  stage.value?.setPointerCapture?.(event.pointerId);
  if (pointers.size === 2) {
    pinchDistance = pointerDistance();
    pinchScale = scale.value;
  }
}

function handlePointerMove(event: PointerEvent): void {
  const previous = pointers.get(event.pointerId);
  if (previous === undefined) {
    return;
  }
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2 && pinchDistance > 0) {
    fitted.value = false;
    scale.value = clampScale(pinchScale * (pointerDistance() / pinchDistance));
    return;
  }
  if (!fitted.value || scale.value > 1) {
    offsetX.value += event.clientX - previous.x;
    offsetY.value += event.clientY - previous.y;
  }
}

function handlePointerEnd(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  stage.value?.releasePointerCapture?.(event.pointerId);
  if (pointers.size < 2) {
    pinchDistance = 0;
  }
}

function svgBlob(): Blob {
  if (props.item.kind !== "svg") {
    throw new Error("The active media is not an SVG.");
  }
  return new Blob([props.item.svg], { type: "image/svg+xml" });
}

async function pngBlob(): Promise<Blob> {
  const response = props.item.kind === "image" ? await fetch(props.item.src) : null;
  if (response !== null) {
    if (!response.ok) {
      throw new Error("The cached image could not be read.");
    }
    return response.blob();
  }
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("The SVG could not be rasterized.")), {
      once: true,
    });
  });
  image.src = source.value;
  await loaded;
  const width = props.item.width ?? (image.naturalWidth || 1_024);
  const height = props.item.height ?? (image.naturalHeight || 768);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Canvas rendering is unavailable.");
  }
  context.drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("PNG encoding failed.")) : resolve(blob)),
      "image/png",
    );
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadOriginal(): void {
  actionError.value = null;
  if (props.item.kind === "svg") {
    downloadBlob(svgBlob(), props.item.filename);
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = props.item.src;
  anchor.download = props.item.filename;
  anchor.click();
}

async function downloadPng(): Promise<void> {
  try {
    downloadBlob(await pngBlob(), props.item.filename.replace(/\.svg$/iu, ".png"));
  } catch {
    actionError.value = "PNG download failed. The SVG remains available for download.";
  }
}

async function copyCurrentImage(): Promise<void> {
  if (!canCopyImage.value) {
    return;
  }
  try {
    actionError.value = null;
    await copyImage(await pngBlob());
  } catch {
    failCopy();
  }
}

onMounted(async () => {
  if (props.background !== undefined) {
    previousBackgroundInert = props.background.inert;
    props.background.inert = true;
  }
  const element = dialog.value;
  if (element !== null) {
    if (typeof element.showModal === "function") {
      element.showModal();
    } else {
      element.setAttribute("open", "");
    }
  }
  await nextTick();
  stage.value?.focus();
});

onBeforeUnmount(() => {
  if (props.background !== undefined) {
    props.background.inert = previousBackgroundInert;
  }
  pointers.clear();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="media-viewer"
    aria-label="Media viewer"
    aria-modal="true"
    @cancel.prevent="close"
    @click="handleBackdrop"
    @keydown="handleKeydown"
  >
    <header class="media-viewer__toolbar">
      <span class="media-viewer__title">{{ item.alt || item.filename }}</span>
      <span class="media-viewer__actions">
        <UiIconButton label="Zoom out" @click="zoom(-0.25)">
          <PhMagnifyingGlassMinus :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton label="Zoom in" @click="zoom(0.25)">
          <PhMagnifyingGlassPlus :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton label="Fit media" :state="fitted ? 'success' : 'default'" @click="fit">
          <PhArrowsOut :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton label="Original size" @click="originalSize">
          <PhResize :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton label="Reset view" @click="fit">
          <PhArrowCounterClockwise :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton
          :label="item.kind === 'svg' ? 'Download SVG' : 'Download image'"
          @click="downloadOriginal"
        >
          <PhDownloadSimple :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton v-if="item.kind === 'svg'" label="Download PNG" @click="downloadPng">
          <PhDownloadSimple :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton
          :label="copyLabel"
          :tooltip="clipboardTooltip"
          :disabled="!canCopyImage"
          :state="copyState"
          @click="copyCurrentImage"
        >
          <PhCheck v-if="copyState === 'success'" :size="18" weight="regular" aria-hidden="true" />
          <PhWarning
            v-else-if="copyState === 'error'"
            :size="18"
            weight="regular"
            aria-hidden="true"
          />
          <PhCopy v-else :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton label="Close media viewer" @click="close">
          <PhX :size="18" weight="regular" aria-hidden="true" />
        </UiIconButton>
      </span>
    </header>
    <p v-if="actionError !== null" class="media-viewer__error" role="status">
      {{ actionError }}
    </p>
    <div
      ref="stage"
      class="media-viewer__stage"
      tabindex="0"
      autofocus
      @wheel="handleWheel"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerEnd"
      @pointercancel="handlePointerEnd"
    >
      <img
        class="media-viewer__content"
        :class="fitted ? 'is-fitted' : 'is-original'"
        :src="source"
        :alt="item.alt"
        :width="item.width ?? undefined"
        :height="item.height ?? undefined"
        :style="contentStyle"
        draggable="false"
      />
    </div>
  </dialog>
</template>
