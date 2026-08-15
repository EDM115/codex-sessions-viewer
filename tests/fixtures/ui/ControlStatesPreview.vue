<script setup lang="ts">
import { PhGear } from "@phosphor-icons/vue";
import { ref } from "vue";

import UiButton, {
  type UiControlState,
  type UiPreviewState,
} from "../../../app/components/ui/UiButton.vue";
import UiDisclosure from "../../../app/components/ui/UiDisclosure.vue";
import UiIconButton from "../../../app/components/ui/UiIconButton.vue";
import UiMenu from "../../../app/components/ui/UiMenu.vue";
import UiTabs from "../../../app/components/ui/UiTabs.vue";
import UiTextField from "../../../app/components/ui/UiTextField.vue";
import UiTooltip from "../../../app/components/ui/UiTooltip.vue";

type PreviewState =
  | "default"
  | "hover"
  | "focus"
  | "active"
  | "disabled"
  | "loading"
  | "error"
  | "success";

const states: PreviewState[] = [
  "default",
  "hover",
  "focus",
  "active",
  "disabled",
  "loading",
  "error",
  "success",
];
const selectedTab = ref("active");

function previewState(state: PreviewState): UiPreviewState {
  return state === "hover" || state === "focus" || state === "active" ? state : null;
}

function controlState(state: PreviewState): UiControlState {
  return state === "loading" || state === "error" || state === "success" ? state : "default";
}
</script>

<template>
  <article class="control-preview">
    <header class="control-preview__header">
      <h1>Control states</h1>
      <p>Test-only fixture. This component is never mounted by a production route.</p>
    </header>

    <div class="control-preview__legend" aria-hidden="true">
      <span>State</span>
      <span>Buttons</span>
      <span>Icon actions</span>
      <span>Inputs</span>
      <span>Tabs</span>
      <span>Disclosures</span>
      <span>Menus</span>
      <span>Tooltips</span>
    </div>

    <section
      v-for="state in states"
      :key="state"
      class="control-preview__row"
      :data-preview-state="state"
    >
      <h2>{{ state }}</h2>
      <UiButton
        :state="controlState(state)"
        :preview-state="previewState(state)"
        :disabled="state === 'disabled'"
      >
        Save view
      </UiButton>
      <UiIconButton
        label="Open settings"
        :state="controlState(state)"
        :preview-state="previewState(state)"
        :disabled="state === 'disabled'"
      >
        <PhGear :size="20" weight="regular" aria-hidden="true" />
      </UiIconButton>
      <UiTextField
        :id="`preview-${state}`"
        label="Codex home"
        model-value="C:\\Users\\dev\\.codex"
        helper="Read-only source directory."
        :message="state === 'error' ? 'Choose an existing Codex home.' : ''"
        :state="controlState(state)"
        :disabled="state === 'disabled'"
      />
      <UiTabs
        v-model="selectedTab"
        :label="`${state} tabs`"
        :items="[
          { value: 'active', label: 'Active', count: 12 },
          { value: 'archived', label: 'Archived', count: 4, disabled: state === 'disabled' },
        ]"
      />
      <UiDisclosure label="Cache diagnostics" :open="state === 'active' || state === 'success'">
        No parser diagnostics.
      </UiDisclosure>
      <UiMenu label="More actions">
        <button type="button" role="menuitem">Retry</button>
      </UiMenu>
      <UiTooltip text="Open the selected local session">
        <template #default="{ tooltipId }">
          <button type="button" class="interactive-control" :aria-describedby="tooltipId">
            Open
          </button>
        </template>
      </UiTooltip>
    </section>
  </article>
</template>

<style scoped>
.control-preview {
  display: grid;
  gap: var(--space-lg);
  padding: var(--space-xl);
  background: var(--color-canvas);
  color: var(--color-text);
}

.control-preview__header {
  display: grid;
  gap: var(--space-xs);
}

.control-preview__legend,
.control-preview__row {
  display: grid;
  grid-template-columns: 7rem repeat(7, minmax(10rem, 1fr));
  gap: var(--space-md);
  align-items: start;
}

.control-preview__legend {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: 650;
}

.control-preview__row {
  padding-block: var(--space-md);
  border-block-start: var(--rule-thin) solid var(--color-border);
}

.control-preview__row h2 {
  font-family: var(--font-code);
  font-size: var(--text-sm);
  font-weight: 500;
}
</style>
