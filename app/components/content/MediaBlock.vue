<script setup lang="ts">
import { PhDownloadSimple, PhFile, PhImageBroken } from "@phosphor-icons/vue";
import { computed, onMounted, ref, shallowRef } from "vue";

import type { ResolvedAsset } from "#shared/types/repository.ts";
import type { RichTextMediaNode } from "#shared/types/richText.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import UiTooltip from "../ui/UiTooltip.vue";

const props = withDefaults(
  defineProps<{
    node: RichTextMediaNode;
    resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  }>(),
  { resolveAsset: undefined },
);
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();

const asset = shallowRef<ResolvedAsset | null>(null);
const failed = ref(false);
const loading = ref(props.node.source === "asset");
const filename = computed(() => {
  if (props.node.originalSource.startsWith("data:")) {
    return `attachment.${extension.value}`;
  }
  return (
    props.node.originalSource.split(/[\\/]/u).at(-1)?.trim() || `attachment.${extension.value}`
  );
});
const extension = computed(() => {
  const mime = asset.value?.mimeType ?? "";
  return mime.includes("/") ? (mime.split("/")[1] ?? "bin").replace("svg+xml", "svg") : "bin";
});
const available = computed(
  () => asset.value?.status === "available" && asset.value.url !== null && !failed.value,
);

onMounted(async () => {
  if (props.node.source !== "asset") {
    loading.value = false;
    return;
  }
  if (props.node.assetId === null || props.resolveAsset === undefined) {
    loading.value = false;
    return;
  }
  try {
    asset.value = await props.resolveAsset(props.node.assetId);
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
});

function openImage(): void {
  const resolved = asset.value;
  if (resolved?.url === null || resolved?.url === undefined) {
    return;
  }
  emit("openMedia", {
    kind: "image",
    alt: props.node.alt || filename.value,
    filename: filename.value,
    height: resolved.height,
    mimeType: resolved.mimeType ?? "image/png",
    src: resolved.url,
    width: resolved.width,
  });
}
</script>

<template>
  <a
    v-if="node.source === 'external'"
    class="rich-media-placeholder"
    :href="node.originalSource"
    target="_blank"
    rel="noreferrer noopener"
  >
    <PhImageBroken :size="18" weight="regular" aria-hidden="true" />
    <span>{{ node.alt || "Remote image" }}</span>
    <small>Open the original URL</small>
  </a>
  <button
    v-else-if="node.mediaType === 'image' && available"
    type="button"
    class="rich-media-image"
    :aria-label="`Open image: ${node.alt || filename}`"
    @click="openImage"
  >
    <img
      :src="asset!.url!"
      :alt="node.alt"
      loading="lazy"
      :width="asset!.width ?? undefined"
      :height="asset!.height ?? undefined"
      @error="failed = true"
    />
  </button>
  <figure v-else-if="node.mediaType === 'audio' && available" class="rich-media-audio">
    <figcaption>{{ node.alt || filename }}</figcaption>
    <audio :src="asset!.url!" controls preload="metadata" />
    <UiTooltip text="Download audio">
      <template #default="{ tooltipId }">
        <a
          class="ui-icon-button interactive-control"
          :href="asset!.url!"
          :download="filename"
          aria-label="Download audio"
          :aria-describedby="tooltipId"
        >
          <PhDownloadSimple :size="17" weight="regular" aria-hidden="true" />
        </a>
      </template>
    </UiTooltip>
  </figure>
  <a v-else-if="available" class="rich-media-placeholder" :href="asset!.url!" :download="filename">
    <PhFile :size="18" weight="regular" aria-hidden="true" />
    <span>{{ node.alt || filename }}</span>
    <small>Download cached {{ node.mediaType }}</small>
  </a>
  <span v-else class="rich-media-placeholder is-missing" role="status">
    <PhImageBroken :size="18" weight="regular" aria-hidden="true" />
    <span>{{ node.alt || filename }}</span>
    <small>{{ loading ? "Loading cached media…" : "Cached media is unavailable." }}</small>
  </span>
</template>
