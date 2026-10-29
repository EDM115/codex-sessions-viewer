<script setup lang="ts">
import { PhPencilSimple } from "@phosphor-icons/vue";

import { fullFileLines, fileLineCountLabel } from "#shared/timeline/fileChanges.ts";
import { statusLabel } from "#shared/timeline/toolSemantics.ts";
import type {
  DisclosureDefault,
  FileChange,
  FileChangeActivity,
} from "#shared/types/conversation.ts";

const props = defineProps<{
  activities: FileChangeActivity[];
  disclosureKey?: string;
  toolCallsDefault?: DisclosureDefault;
}>();
type PresentedFile = FileChange & { presentationKey: string };
const files = computed(() =>
  props.activities.flatMap((activity) =>
    activity.files.map((file, index) => ({ ...file, presentationKey: `${activity.id}:${index}` })),
  ),
);
const { open, toggle } = useWorkDisclosure(
  () => `${props.disclosureKey ?? props.activities[0]?.id}:files`,
  () =>
    props.activities.some((activity) => activity.status === "failed")
      ? "error"
      : props.activities.some((activity) => activity.status === "cancelled")
        ? "cancelled"
        : props.activities.some((activity) => activity.status === "running")
          ? "running"
          : "unknown",
  () => props.toolCallsDefault ?? "collapsed",
);
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
    return `Edited ${name} (${fileLineCountLabel(file)})`;
  }
  return `${created ? "Created" : "Edited"} ${count} files`;
});

const totals = computed(() => {
  let added = 0;
  let removed = 0;
  for (const file of files.value) {
    if (file.addedLines === null || file.removedLines === null) {
      return "Line counts unavailable";
    }
    added += file.addedLines;
    removed += file.removedLines;
  }
  return `${added} added · ${removed} removed`;
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
  const lines = fullFileLines(content);
  const deleted = file.change === "delete";
  const hunk = deleted ? `@@ -1,${lines.length} +0,0 @@` : `@@ -0,0 +1,${lines.length} @@`;
  return `--- ${before}\n+++ ${after}\n${hunk}\n${lines.map((line) => `${deleted ? "-" : "+"}${line}`).join("\n")}`;
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
    :open="open"
    @toggle="toggle"
  >
    <summary :aria-expanded="open">
      <PhPencilSimple :size="18" aria-hidden="true" />
      <strong>{{ label }}</strong>
      <span
        v-for="status in new Set(activities.map((activity) => activity.status))"
        :key="status"
        >{{ statusLabel(status) }}</span
      >
      <span class="tabular">{{ totals }}</span>
    </summary>
    <div v-if="open" class="conversation-file-changes__files">
      <details v-for="file in files" :key="fileKey(file)" @toggle="onFileToggle($event, file)">
        <summary :aria-expanded="openedFiles.has(fileKey(file))">
          <span>{{ file.path }}</span>
          <span class="tabular">{{ fileLineCountLabel(file) }}</span>
        </summary>
        <template v-if="openedFiles.has(fileKey(file))">
          <ContentDiffBlock v-if="diffSource(file) !== null" :source="diffSource(file)!" wrapped />
          <p v-else>No textual diff was recorded for this file.</p>
        </template>
      </details>
    </div>
  </details>
</template>
