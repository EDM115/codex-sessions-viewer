<script setup lang="ts">
import {
  PhBroadcast,
  PhCheck,
  PhDatabase,
  PhFloppyDisk,
  PhImageSquare,
  PhLockKey,
  PhMagnifyingGlass,
  PhWarningCircle,
} from "@phosphor-icons/vue";

import type { DisclosureDefault, ViewerTheme } from "#shared/types/conversation.ts";
import type { ViewerDiagnostic } from "#shared/types/diagnostics.ts";
import type { RepositoryCapabilities, RepositoryMode } from "#shared/types/repository.ts";
import type { PresentationSettings } from "#shared/types/settings.ts";

import UiIconButton from "../ui/UiIconButton.vue";
import UiTextField from "../ui/UiTextField.vue";

const props = defineProps<{
  capabilities: RepositoryCapabilities;
  codexHome: string;
  diagnostics: ViewerDiagnostic[];
  fetchFavicons: boolean | null;
  mode: RepositoryMode;
  pagefindEnabled: boolean;
  presentation: PresentationSettings;
  saveState: "default" | "loading" | "error" | "success";
}>();

const emit = defineEmits<{
  "save-codex-home": [];
  "update:codex-home": [value: string];
  "update:live-follow": [value: boolean];
  "update:reasoning-default": [value: DisclosureDefault];
  "update:theme": [value: ViewerTheme];
  "update:timestamp-format": [value: PresentationSettings["timestampFormat"]];
  "update:tool-default": [value: DisclosureDefault];
  "update:turn-minimap": [value: boolean];
  "update:wrap-code": [value: boolean];
}>();

const themes: Array<{ value: ViewerTheme; label: string; description: string }> = [
  {
    value: "midnight-glass",
    label: "Midnight Glass",
    description: "Deep navy, violet emphasis, cyan live status.",
  },
  {
    value: "quiet-precision",
    label: "Quiet Precision",
    description: "Graphite navigation and a bright paper canvas.",
  },
  {
    value: "editorial-archive",
    label: "Editorial Archive",
    description: "Parchment, ink, and restrained terracotta.",
  },
];

function disclosureValue(event: Event): DisclosureDefault {
  return (event.target as HTMLSelectElement).value === "expanded" ? "expanded" : "collapsed";
}

function timestampValue(event: Event): PresentationSettings["timestampFormat"] {
  const value = (event.target as HTMLSelectElement).value;
  return value === "absolute" || value === "relative" ? value : "both";
}

function checked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked;
}
</script>

<template>
  <div class="settings-panel">
    <header class="settings-hero">
      <p class="settings-hero__kicker">Viewer configuration</p>
      <div class="settings-hero__body">
        <h1 class="settings-hero__title theme-display">
          Settings are explicit, local, and reversible.
        </h1>
        <p class="settings-hero__lead">
          Presentation preferences stay in this browser. Source configuration is available only when
          the live loopback server can validate it.
        </p>
      </div>
    </header>

    <section class="settings-section" aria-labelledby="settings-source-heading">
      <header class="settings-section__heading">
        <div>
          <p class="settings-section__index tabular">01</p>
          <h2 id="settings-source-heading">Source and cache</h2>
        </div>
        <p>{{ mode === "live" ? "Live local runtime" : "Immutable static publication" }}</p>
      </header>
      <div class="settings-source-control">
        <UiTextField
          id="settings-codex-home"
          :model-value="codexHome"
          label="Codex home"
          :disabled="!capabilities.serverSettings"
          :readonly="!capabilities.serverSettings"
          :state="saveState"
          :helper="
            capabilities.serverSettings
              ? 'Validated before the watcher changes source context.'
              : 'To change this value, rerun pnpm export --codex-home <path>.'
          "
          @update:model-value="emit('update:codex-home', $event)"
        />
        <UiIconButton
          v-if="capabilities.serverSettings"
          label="Save Codex home"
          tooltip="Validate and switch Codex home"
          :state="saveState"
          @click="emit('save-codex-home')"
        >
          <PhFloppyDisk :size="20" weight="regular" aria-hidden="true" />
        </UiIconButton>
      </div>
      <dl class="settings-facts">
        <div>
          <dt><PhImageSquare :size="18" weight="regular" aria-hidden="true" /> Favicon cache</dt>
          <dd>
            {{
              mode === "static"
                ? "Bundled at export time"
                : fetchFavicons
                  ? "Background fetch enabled"
                  : "Background fetch disabled"
            }}
          </dd>
        </div>
        <div>
          <dt><PhDatabase :size="18" weight="regular" aria-hidden="true" /> Cache and export</dt>
          <dd>
            {{
              diagnostics.length === 0
                ? "No current diagnostics"
                : `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"} require attention`
            }}
          </dd>
        </div>
      </dl>
      <div class="settings-guarantee">
        <PhLockKey :size="22" weight="regular" aria-hidden="true" />
        <div>
          <h3>Read-only guarantee</h3>
          <p>
            Codex files are never written, renamed, locked, migrated, or deleted. The viewer reads
            stable snapshots and stores only its own derived cache and browser preferences.
          </p>
        </div>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="settings-presentation-heading">
      <header class="settings-section__heading">
        <div>
          <p class="settings-section__index tabular">02</p>
          <h2 id="settings-presentation-heading">Presentation</h2>
        </div>
        <p>Persisted after hydration</p>
      </header>
      <fieldset class="settings-theme-choices">
        <legend>Theme</legend>
        <button
          v-for="theme in themes"
          :key="theme.value"
          type="button"
          class="settings-theme-choice interactive-control"
          :class="presentation.theme === theme.value ? 'is-selected' : null"
          :data-theme-choice="theme.value"
          :aria-pressed="presentation.theme === theme.value"
          @click="emit('update:theme', theme.value)"
        >
          <span
            class="settings-theme-choice__swatch"
            :data-preview-theme="theme.value"
            aria-hidden="true"
          />
          <span
            ><strong>{{ theme.label }}</strong
            ><small>{{ theme.description }}</small></span
          >
          <PhCheck
            v-if="presentation.theme === theme.value"
            :size="18"
            weight="regular"
            aria-hidden="true"
          />
        </button>
      </fieldset>
      <div class="settings-control-list">
        <label class="settings-select-row">
          <span
            ><strong>Tool calls by default</strong
            ><small>Choose the initial disclosure state for tool activity.</small></span
          >
          <select
            class="interactive-control"
            :value="presentation.toolCallsDefault"
            @change="emit('update:tool-default', disclosureValue($event))"
          >
            <option value="collapsed">Collapsed</option>
            <option value="expanded">Expanded</option>
          </select>
        </label>
        <label class="settings-select-row">
          <span
            ><strong>Reasoning by default</strong
            ><small>Choose the initial disclosure state for reasoning summaries.</small></span
          >
          <select
            class="interactive-control"
            :value="presentation.reasoningDefault"
            @change="emit('update:reasoning-default', disclosureValue($event))"
          >
            <option value="collapsed">Collapsed</option>
            <option value="expanded">Expanded</option>
          </select>
        </label>
        <label class="settings-select-row">
          <span
            ><strong>Timestamp format</strong
            ><small>Use relative context, exact values, or both.</small></span
          >
          <select
            class="interactive-control"
            :value="presentation.timestampFormat"
            @change="emit('update:timestamp-format', timestampValue($event))"
          >
            <option value="relative">Relative</option>
            <option value="absolute">Absolute</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label class="settings-toggle-row">
          <span
            ><strong>Wrap code</strong
            ><small>Allow long code lines to wrap in the transcript.</small></span
          >
          <input
            type="checkbox"
            :checked="presentation.wrapCode"
            @change="emit('update:wrap-code', checked($event))"
          />
        </label>
        <label
          class="settings-toggle-row"
          :class="!capabilities.liveUpdates ? 'is-disabled' : null"
        >
          <span
            ><strong>Live follow</strong
            ><small>{{
              capabilities.liveUpdates
                ? "Stay at the live edge while new turns arrive."
                : "Unavailable in a static export because no live event stream exists."
            }}</small></span
          >
          <input
            type="checkbox"
            :checked="presentation.liveFollow"
            :disabled="!capabilities.liveUpdates"
            @change="emit('update:live-follow', checked($event))"
          />
        </label>
        <label class="settings-toggle-row">
          <span
            ><strong>Turn minimap</strong
            ><small>Show the compact conversation navigator when space allows.</small></span
          >
          <input
            type="checkbox"
            :checked="presentation.turnMinimap"
            @change="emit('update:turn-minimap', checked($event))"
          />
        </label>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="settings-capabilities-heading">
      <header class="settings-section__heading">
        <div>
          <p class="settings-section__index tabular">03</p>
          <h2 id="settings-capabilities-heading">Diagnostics and capabilities</h2>
        </div>
        <p>{{ diagnostics.length }} current</p>
      </header>
      <dl class="settings-capabilities">
        <div>
          <dt><PhBroadcast :size="18" weight="regular" aria-hidden="true" /> Updates</dt>
          <dd>
            {{
              capabilities.liveUpdates
                ? "SSE invalidations and targeted refetch"
                : "Frozen at export revision"
            }}
          </dd>
        </div>
        <div>
          <dt>
            <PhMagnifyingGlass :size="18" weight="regular" aria-hidden="true" /> Search boundary
          </dt>
          <dd>
            {{
              mode === "live"
                ? "Local SQLite full-text index"
                : pagefindEnabled
                  ? "Bundled Pagefind exact-turn index"
                  : "Session metadata only"
            }}
          </dd>
        </div>
        <div>
          <dt><PhImageSquare :size="18" weight="regular" aria-hidden="true" /> Rich content</dt>
          <dd>
            {{
              capabilities.backgroundFaviconFetch
                ? "Local cache may refresh missing favicons"
                : "Only content embedded during export"
            }}
          </dd>
        </div>
      </dl>
      <div
        v-if="diagnostics.length > 0"
        class="settings-diagnostics"
        aria-label="Current diagnostics"
      >
        <article v-for="diagnostic in diagnostics" :key="diagnostic.id">
          <PhWarningCircle :size="19" weight="regular" aria-hidden="true" />
          <div>
            <h3>{{ diagnostic.code }}</h3>
            <p>{{ diagnostic.message }}</p>
            <code v-if="diagnostic.path">{{ diagnostic.path }}</code>
          </div>
        </article>
      </div>
      <p v-else class="settings-diagnostics-empty">
        <PhCheck :size="18" weight="regular" aria-hidden="true" /> No source, metadata,
        configuration, or cache diagnostics are currently reported.
      </p>
    </section>
  </div>
</template>
