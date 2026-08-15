import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import SettingsPanel from "../../../app/components/settings/SettingsPanel.vue";
import { DEFAULT_PRESENTATION_SETTINGS } from "../../../shared/types/settings.ts";

describe("SettingsPanel", () => {
  it("explains static limitations and preserves presentation controls", async () => {
    const wrapper = mount(SettingsPanel, {
      props: {
        mode: "static",
        codexHome: "Embedded at export time",
        fetchFavicons: null,
        diagnostics: [],
        capabilities: {
          liveUpdates: false,
          serverSettings: false,
          backgroundFaviconFetch: false,
        },
        pagefindEnabled: false,
        presentation: { ...DEFAULT_PRESENTATION_SETTINGS },
        saveState: "default",
      },
    });

    expect(wrapper.get("#settings-codex-home").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("pnpm export --codex-home");
    expect(wrapper.text()).toContain("never written, renamed, locked, migrated, or deleted");
    expect(wrapper.text()).toContain("Session metadata only");

    await wrapper.get('[data-theme-choice="quiet-precision"]').trigger("click");
    expect(wrapper.emitted("update:theme")?.at(-1)).toEqual(["quiet-precision"]);
  });

  it("offers an accessible compact save action only in live mode", async () => {
    const wrapper = mount(SettingsPanel, {
      props: {
        mode: "live",
        codexHome: "C:/Users/local/.codex",
        fetchFavicons: true,
        diagnostics: [],
        capabilities: {
          liveUpdates: true,
          serverSettings: true,
          backgroundFaviconFetch: true,
        },
        pagefindEnabled: true,
        presentation: { ...DEFAULT_PRESENTATION_SETTINGS },
        saveState: "default",
      },
    });

    await wrapper.get('button[aria-label="Save Codex home"]').trigger("click");
    expect(wrapper.emitted("save-codex-home")).toHaveLength(1);
  });
});
