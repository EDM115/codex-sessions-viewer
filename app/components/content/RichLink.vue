<script setup lang="ts">
import { PhCheck, PhCopy, PhFile, PhGlobe, PhWarning } from "@phosphor-icons/vue";

import { canonicalWebsiteUrl, type LinkPreview } from "#shared/types/linkPreview.ts";
import type { ResolvedAsset } from "#shared/types/repository.ts";
import type { RichTextLinkNode, RichTextNode as RichNode } from "#shared/types/richText.ts";
import { faviconRevision } from "~/components/content/faviconAvailability.ts";
import type { MediaViewerItem } from "~/composables/useMediaViewer.ts";

const props = withDefaults(
  defineProps<{
    node: RichTextLinkNode;
    resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
    resolveFavicon?: (origin: string) => Promise<string | null>;
  }>(),
  { resolveAsset: undefined, resolveFavicon: undefined },
);
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();

interface FileReference {
  column: number | null;
  line: number | null;
  path: string;
}

function coordinates(value: string): { column: number | null; line: number | null } {
  const match = /(?:#L|:)(\d+)(?:C|:)(\d+)$/iu.exec(value) ?? /(?:#L|:)(\d+)$/iu.exec(value);
  return {
    line: match?.[1] === undefined ? null : Number.parseInt(match[1], 10),
    column: match?.[2] === undefined ? null : Number.parseInt(match[2], 10),
  };
}

function fileReference(value: string): FileReference | null {
  const isFileUrl = value.toLowerCase().startsWith("file://");
  const isLocalPath = /^(?:[a-z]:[\\/]|\\\\|\.\.?[\\/]|\/)/iu.test(value);
  if (!isFileUrl && !isLocalPath) {
    return null;
  }
  const position = coordinates(value);
  let path = value.replace(/#L\d+(?:C\d+)?$/iu, "").replace(/:\d+(?::\d+)?$/u, "");
  if (isFileUrl) {
    try {
      const url = new URL(path);
      path = `${url.hostname ? `//${url.hostname}` : ""}${url.pathname}`;
      if (/^\/[a-z]:\//iu.test(path)) {
        path = path.slice(1);
      }
    } catch {
      path = path.slice("file://".length);
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    /* Preserve malformed literal percent encodings. */
  }
  if (/^(?:[a-z]:\/|\/\/)/iu.test(path)) {
    path = path.replaceAll("/", "\\");
  }
  return { path, ...position };
}

const file = computed(() => (props.node.origin === null ? fileReference(props.node.url) : null));
function containsMedia(node: RichNode): boolean {
  return (
    node.type === "media" ||
    node.type === "mermaid" ||
    ("children" in node && node.children.some(containsMedia))
  );
}
const hasMedia = computed(() => props.node.children.some(containsMedia));
const linkAttributes = computed(() =>
  Object.fromEntries(
    Object.entries(props.node.attributes ?? {})
      .filter(
        ([name]) =>
          name === "id" ||
          name === "ariaDescribedBy" ||
          name === "ariaLabelledBy" ||
          name === "ariaLabel",
      )
      .map(([name, value]) => [name.replace(/^aria/u, "aria-").toLowerCase(), value]),
  ),
);
const faviconUrl = ref<string | null>(null);
const faviconFailed = ref(false);
const { copyText, state } = useClipboard();
const copyLabel = computed(() =>
  state.value === "success" ? "Copied: Copy file path" : "Copy file path",
);
const external = computed(() => props.node.origin !== null);
const previewResolver = useLinkPreviewResolver();
const previewTrigger = ref<HTMLAnchorElement | null>(null);
const previewCard = ref<HTMLElement | null>(null);
const previewOpenLink = ref<HTMLAnchorElement | null>(null);
const previewId = useId();
const preview = shallowRef<LinkPreview | null>(null);
const previewOpen = ref(false);
const previewLoading = ref(false);
const previewImageFailed = ref(false);
const previewPosition = ref({ left: "12px", top: "12px", maxHeight: "320px" });
let previewController: AbortController | null = null;
let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let previewGeneration = 0;
let previewDismissed = false;
const previewUrl = computed(() => {
  try {
    return external.value && previewResolver ? canonicalWebsiteUrl(props.node.url) : null;
  } catch {
    return null;
  }
});
const previewHostname = computed(() => {
  try {
    return new URL(props.node.url).hostname;
  } catch {
    return "Website";
  }
});
function positionPreview() {
  if (!previewOpen.value || !previewTrigger.value) {
    return;
  }
  const rect = previewTrigger.value.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  const height = Math.min(previewCard.value?.offsetHeight || 200, 320, window.innerHeight - 24);
  const top =
    rect.top >= height + 16
      ? rect.top - height - 8
      : Math.min(rect.bottom + 8, window.innerHeight - height - 12);
  previewPosition.value = {
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    top: `${Math.max(12, top)}px`,
    maxHeight: `${Math.max(80, Math.min(320, window.innerHeight - 24))}px`,
  };
}
function clearPreviewTimers() {
  clearTimeout(prefetchTimer);
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
}
function closePreview(restoreFocus = false) {
  clearPreviewTimers();
  previewOpen.value = false;
  previewLoading.value = false;
  previewGeneration += 1;
  previewController?.abort();
  previewController = null;
  if (restoreFocus) {
    previewDismissed = true;
    previewTrigger.value?.focus();
  }
}
async function fetchPreview() {
  const url = previewUrl.value;
  if (!url || !previewResolver || previewLoading.value || preview?.value?.url === url) {
    return;
  }
  const generation = ++previewGeneration;
  const controller = new AbortController();
  previewController = controller;
  previewLoading.value = true;
  try {
    const value = await previewResolver(url, { signal: controller.signal });
    if (
      generation === previewGeneration &&
      !controller.signal.aborted &&
      previewUrl.value === url
    ) {
      preview.value = value;
      previewImageFailed.value = false;
    }
  } catch {
    /* Keep the usable hostname and original destination */
  } finally {
    if (generation === previewGeneration) {
      previewLoading.value = false;
      previewController = null;
      await nextTick();
      positionPreview();
    }
  }
}
function showPreview() {
  if (!previewUrl.value) {
    return;
  }
  previewOpen.value = true;
  void fetchPreview();
  void nextTick(positionPreview);
}
function enterPreview(event: PointerEvent) {
  if (event.pointerType === "touch" || event.buttons || !previewUrl.value) {
    return;
  }
  clearPreviewTimers();
  previewDismissed = false;
  prefetchTimer = setTimeout(() => {
    void fetchPreview();
  }, 200);
  openTimer = setTimeout(showPreview, 700);
}
function leavePreview() {
  clearTimeout(prefetchTimer);
  clearTimeout(openTimer);
  closeTimer = setTimeout(() => {
    if (
      !previewCard.value?.contains(document.activeElement) &&
      document.activeElement !== previewTrigger.value
    ) {
      closePreview();
    }
  }, 120);
}
function focusPreview() {
  clearPreviewTimers();
  if (!previewDismissed) {
    showPreview();
  }
}
function previewKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    previewDismissed = true;
    closePreview(previewCard.value?.contains(document.activeElement));
  } else if (
    event.key === "Tab" &&
    previewOpen.value &&
    !event.shiftKey &&
    event.target === previewTrigger.value
  ) {
    event.preventDefault();
    previewOpenLink.value?.focus();
  } else if (event.key === "Tab" && event.shiftKey && event.target === previewOpenLink.value) {
    event.preventDefault();
    previewTrigger.value?.focus();
  }
}
watch(
  () => props.node.url,
  () => {
    closePreview();
    preview.value = null;
    previewDismissed = false;
  },
);
onMounted(() => {
  window.addEventListener("resize", positionPreview);
  window.addEventListener("scroll", positionPreview, true);
});
onBeforeUnmount(() => {
  closePreview();
  window.removeEventListener("resize", positionPreview);
  window.removeEventListener("scroll", positionPreview, true);
});

onMounted(() => {
  watch(
    () =>
      [
        props.node.origin,
        props.resolveFavicon,
        props.node.origin === null ? undefined : faviconRevision(props.node.origin),
      ] as const,
    async ([origin, resolveFavicon, revision], _, onCleanup) => {
      let current = true;
      onCleanup(() => {
        current = false;
      });
      faviconUrl.value = null;
      faviconFailed.value = false;
      if (origin === null || resolveFavicon === undefined) {
        return;
      }
      try {
        const url = await resolveFavicon(origin);
        if (current && url !== null) {
          faviconUrl.value =
            revision === undefined
              ? url
              : `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(revision)}`;
        }
      } catch {
        if (current) {
          faviconUrl.value = null;
        }
      }
    },
    { immediate: true },
  );
});
</script>

<template>
  <span v-if="file !== null" class="rich-file-reference">
    <PhFile :size="16" weight="regular" aria-hidden="true" />
    <span class="rich-file-reference__label">
      <ContentRichTextNode
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        :resolve-asset="resolveAsset"
        :resolve-favicon="resolveFavicon"
        @open-media="emit('openMedia', $event)"
      />
    </span>
    <span class="rich-file-reference__path">{{ file.path }}</span>
    <span v-if="file.line !== null" class="rich-file-reference__position">
      L{{ file.line }}<template v-if="file.column !== null">:C{{ file.column }}</template>
    </span>
    <UiIconButton :label="copyLabel" :state="state" @click="copyText(file.path)">
      <PhCheck v-if="state === 'success'" :size="16" weight="regular" aria-hidden="true" />
      <PhWarning v-else-if="state === 'error'" :size="16" weight="regular" aria-hidden="true" />
      <PhCopy v-else :size="16" weight="regular" aria-hidden="true" />
    </UiIconButton>
  </span>
  <span v-else-if="hasMedia" class="rich-linked-media">
    <ContentRichTextNode
      v-for="(child, index) in node.children"
      :key="index"
      :node="child"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
    <a
      class="rich-link"
      v-bind="linkAttributes"
      :href="node.url"
      :title="node.title ?? undefined"
      :target="external ? '_blank' : undefined"
      :rel="external ? 'noreferrer noopener' : undefined"
      >Open linked destination</a
    >
  </span>
  <span
    v-else
    class="rich-link-shell"
    @pointerenter="enterPreview"
    @pointerleave="leavePreview"
    @keydown="previewKey"
  >
    <a
      ref="previewTrigger"
      class="rich-link"
      v-bind="linkAttributes"
      :href="node.url"
      :title="node.title ?? undefined"
      :target="external ? '_blank' : undefined"
      :rel="external ? 'noreferrer noopener' : undefined"
      :aria-haspopup="previewUrl ? 'dialog' : undefined"
      :aria-expanded="previewUrl ? previewOpen : undefined"
      :aria-controls="previewOpen ? previewId : undefined"
      @focus="focusPreview"
      @blur="leavePreview"
      @pointerdown="closePreview()"
      @click="closePreview()"
      @dragstart="closePreview()"
    >
      <span v-if="external" class="rich-link__icon" aria-hidden="true">
        <img
          v-if="faviconUrl !== null && !faviconFailed"
          :src="faviconUrl"
          alt=""
          width="16"
          height="16"
          @error="faviconFailed = true"
        />
        <PhGlobe v-else :size="16" weight="regular" />
      </span>
      <ContentRichTextNode
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        :resolve-asset="resolveAsset"
        :resolve-favicon="resolveFavicon"
        @open-media="emit('openMedia', $event)"
      />
    </a>
    <Teleport to="body">
      <aside
        v-if="previewOpen"
        :id="previewId"
        ref="previewCard"
        class="website-preview"
        role="dialog"
        :aria-label="`Website preview for ${previewHostname}`"
        :style="previewPosition"
        @pointerenter="clearPreviewTimers"
        @pointerleave="leavePreview"
        @focusin="clearPreviewTimers"
        @focusout="leavePreview"
        @keydown="previewKey"
      >
        <div class="website-preview__header">
          <span>{{ previewHostname }}</span
          ><a ref="previewOpenLink" :href="node.url" target="_blank" rel="noreferrer noopener"
            >Open<span class="visually-hidden"> {{ previewHostname }}</span></a
          >
        </div>
        <p v-if="previewLoading" role="status">Loading preview…</p>
        <template v-else>
          <img
            v-if="preview?.image && !previewImageFailed"
            :class="
              preview.image.width / preview.image.height >= 1.2
                ? 'website-preview__hero'
                : 'website-preview__thumbnail'
            "
            :src="preview.image.url"
            :width="preview.image.width"
            :height="preview.image.height"
            alt=""
            decoding="async"
            referrerpolicy="no-referrer"
            @load="positionPreview"
            @error="previewImageFailed = true"
          />
          <strong v-if="preview?.title" class="website-preview__title">{{ preview.title }}</strong>
          <p v-if="preview?.description" class="website-preview__description">
            {{ preview.description }}
          </p>
          <small v-if="preview?.fetchedAt">Saved website preview</small>
        </template>
      </aside>
    </Teleport>
  </span>
</template>
