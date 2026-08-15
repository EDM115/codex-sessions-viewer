<script setup lang="ts">
import { PhCheck, PhCopy, PhWarning } from "@phosphor-icons/vue";
import { nextTick, ref, useId } from "vue";

import { useClipboard } from "../../composables/useClipboard.ts";
import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import UiIconButton from "../ui/UiIconButton.vue";

const props = defineProps<{ source: string }>();
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();

const diagramId = `mermaid-${useId().replaceAll(/[^a-z\d_-]/giu, "")}`;
const tab = ref<"code" | "preview">("code");
const tablist = ref<HTMLElement | null>(null);
const preview = ref<HTMLElement | null>(null);
const previewState = ref<"error" | "idle" | "loading" | "ready">("idle");
const sanitizedSvg = ref<string | null>(null);
const { copyText, state: copyState } = useClipboard();

function safeSvg(source: string): { element: SVGElement; serialized: string } {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== "http://www.w3.org/2000/svg" ||
    parsed.querySelector("parsererror") !== null
  ) {
    throw new Error("Mermaid returned an invalid SVG document.");
  }
  for (const element of root.querySelectorAll("script, foreignObject, iframe, object, embed")) {
    element.remove();
  }
  function sanitizeElement(element: Element): void {
    for (const attribute of Array.from(element.attributes)) {
      if (
        /^on/iu.test(attribute.name) ||
        ((attribute.name === "href" || attribute.name === "xlink:href") &&
          /^(?:data|javascript):/iu.test(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  sanitizeElement(root);
  for (const element of root.querySelectorAll("*")) {
    sanitizeElement(element);
  }
  const serialized = new XMLSerializer().serializeToString(root);
  return { element: root as unknown as SVGElement, serialized };
}

async function renderPreview(): Promise<void> {
  tab.value = "preview";
  if (previewState.value === "loading" || previewState.value === "ready") {
    return;
  }
  previewState.value = "loading";
  await nextTick();
  try {
    const { default: mermaid } = await import("mermaid");
    const rootStyle = getComputedStyle(document.documentElement);
    mermaid.initialize({
      fontFamily: rootStyle.getPropertyValue("--font-body").trim(),
      htmlLabels: false,
      securityLevel: "strict",
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
      ],
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: rootStyle.colorScheme.includes("dark") ? "dark" : "neutral",
    });
    const rendered = await mermaid.render(diagramId, props.source);
    const safe = safeSvg(rendered.svg);
    const target = preview.value;
    if (target === null) {
      throw new Error("The Mermaid preview surface is unavailable.");
    }
    target.replaceChildren(document.importNode(safe.element, true));
    sanitizedSvg.value = safe.serialized;
    previewState.value = "ready";
  } catch {
    sanitizedSvg.value = null;
    previewState.value = "error";
  }
}

function showCode(): void {
  tab.value = "code";
}

function handleTabKey(event: KeyboardEvent): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  const previewNext = event.key === "ArrowLeft" || event.key === "Home";
  if (previewNext) {
    void renderPreview().then(() => {
      tablist.value
        ?.querySelector<HTMLButtonElement>('[aria-label="Preview Mermaid diagram"]')
        ?.focus();
      return undefined;
    });
  } else {
    showCode();
    void nextTick().then(() => {
      tablist.value?.querySelector<HTMLButtonElement>('[aria-label="Show Mermaid code"]')?.focus();
      return undefined;
    });
  }
}

function openPreview(): void {
  if (sanitizedSvg.value === null) {
    return;
  }
  emit("openMedia", {
    kind: "svg",
    alt: "Mermaid diagram",
    filename: "diagram.svg",
    height: null,
    mimeType: "image/svg+xml",
    source: props.source,
    svg: sanitizedSvg.value,
    width: null,
  });
}
</script>

<template>
  <figure class="rich-mermaid">
    <figcaption class="rich-mermaid__header">
      <span>Mermaid</span>
      <span
        ref="tablist"
        class="rich-mermaid__tabs"
        role="tablist"
        aria-label="Mermaid view"
        @keydown="handleTabKey"
      >
        <button
          type="button"
          role="tab"
          aria-label="Preview Mermaid diagram"
          :aria-selected="tab === 'preview'"
          :tabindex="tab === 'preview' ? 0 : -1"
          @click="renderPreview"
        >
          Preview
        </button>
        <button
          type="button"
          role="tab"
          aria-label="Show Mermaid code"
          :aria-selected="tab === 'code'"
          :tabindex="tab === 'code' ? 0 : -1"
          @click="showCode"
        >
          Code
        </button>
      </span>
    </figcaption>
    <section v-show="tab === 'code'" class="rich-mermaid__code" role="tabpanel">
      <UiIconButton
        :label="copyState === 'success' ? 'Copied: Copy Mermaid code' : 'Copy Mermaid code'"
        :state="copyState"
        @click="copyText(source)"
      >
        <PhCheck v-if="copyState === 'success'" :size="16" weight="regular" aria-hidden="true" />
        <PhWarning
          v-else-if="copyState === 'error'"
          :size="16"
          weight="regular"
          aria-hidden="true"
        />
        <PhCopy v-else :size="16" weight="regular" aria-hidden="true" />
      </UiIconButton>
      <pre><code>{{ source }}</code></pre>
    </section>
    <section v-show="tab === 'preview'" class="rich-mermaid__preview" role="tabpanel">
      <p v-if="previewState === 'loading'" class="rich-mermaid__state" role="status">
        Rendering Mermaid preview…
      </p>
      <p v-else-if="previewState === 'error'" class="rich-content-error" role="status">
        Mermaid preview failed. Open the Code tab to inspect the original source.
      </p>
      <button
        v-show="previewState === 'ready'"
        type="button"
        class="rich-mermaid__open"
        aria-label="Open Mermaid diagram"
        @click="openPreview"
      >
        <span ref="preview" data-mermaid-preview />
      </button>
    </section>
  </figure>
</template>
