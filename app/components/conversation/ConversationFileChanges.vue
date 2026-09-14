<script setup lang="ts">
import { PhPencilSimple } from "@phosphor-icons/vue";
import { computed, ref } from "vue";

import type { FileChange, FileChangeActivity } from "#shared/types/conversation.ts";

import DiffBlock from "../content/DiffBlock.client.vue";
import { statusLabel } from "./toolPresentation.ts";

const props = defineProps<{ activities: FileChangeActivity[] }>();
type PresentedFile = FileChange & { presentationKey: string };
const files = computed(() =>
  props.activities.flatMap((activity) =>
    activity.files.map((file, index) => ({ ...file, presentationKey: `${activity.id}:${index}` })),
  ),
);
const open = ref(false);
const openedFiles = ref(new Set<string>());
const label = computed(() => {
  const count = files.value.length;
  if (props.activities.some((activity) => activity.status !== "succeeded")) {
    return `File changes · ${count} files`;
  }
  const created = files.value.every(({ change }) => change === "add");
  if (count === 1) {
    const file = files.value[0]!;
    const name = file.path.replaceAll("\\", "/").split("/").at(-1) ?? file.path;
    if (file.change === "add") {
      return `Created ${name}`;
    }
    if (file.change === "delete") {
      return `Deleted ${name}`;
    }
    if (file.change === "move") {
      return `Moved ${name}`;
    }
    return `Edited ${name} +${file.addedLines} −${file.removedLines}`;
  }
  return `${created ? "Created" : "Edited"} ${count} files`;
});

function diffSource(file: FileChange): string | null {
  if (file.diff === null && file.content === null) {
    return null;
  }
  const before = file.change === "add" ? "/dev/null" : `a/${file.previousPath ?? file.path}`;
  const after = file.change === "delete" ? "/dev/null" : `b/${file.path}`;
  if (file.diff !== null) {
    return `--- ${before}\n+++ ${after}\n${file.diff}`;
  }
  const content = file.content ?? "";
  const lines = content === "" ? [] : content.split("\n");
  return `--- ${before}\n+++ ${after}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
}

function fileKey(file: PresentedFile): string {
  return file.presentationKey;
}

function onFileToggle(event: Event, file: PresentedFile): void {
  const details = event.currentTarget as HTMLDetailsElement;
  const next = new Set(openedFiles.value);
  if (details.open) {
    next.add(fileKey(file));
  } else {
    next.delete(fileKey(file));
  }
  openedFiles.value = next;
}
</script>

<template>
  <details
    class="conversation-file-changes"
    :data-entry-id="activities[0]?.id"
    @toggle="open = ($event.currentTarget as HTMLDetailsElement).open"
  >
    <summary>
      <PhPencilSimple :size="18" aria-hidden="true" />
      <strong>{{ label }}</strong>
      <span
        v-for="status in new Set(activities.map((activity) => activity.status))"
        :key="status"
        >{{ statusLabel(status) }}</span
      >
      <span class="tabular"
        >{{ files.reduce((total, file) => total + file.addedLines, 0) }} added ·
        {{ files.reduce((total, file) => total + file.removedLines, 0) }} removed</span
      >
    </summary>
    <div v-if="open" class="conversation-file-changes__files">
      <details v-for="file in files" :key="fileKey(file)" @toggle="onFileToggle($event, file)">
        <summary>
          <span>{{ file.path }}</span>
          <span class="tabular">+{{ file.addedLines }} −{{ file.removedLines }}</span>
        </summary>
        <template v-if="openedFiles.has(fileKey(file))">
          <DiffBlock v-if="diffSource(file) !== null" :source="diffSource(file)!" wrapped />
          <p v-else>No textual diff was recorded for this file.</p>
        </template>
      </details>
    </div>
  </details>
</template>
