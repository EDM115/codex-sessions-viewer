import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, defineComponent, h, nextTick } from "vue";
import { renderToString } from "vue/server-renderer";

import {
  DEFAULT_PRESENTATION_SETTINGS,
  PRESENTATION_SETTINGS_STORAGE_KEY,
} from "../../../shared/types/settings.ts";

const renders = vi.hoisted(() => ({
  diff: vi.fn<(options: { themeType: string }) => void>(),
  mermaid: vi.fn<(options: { theme: string }) => void>(),
}));
vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [{ files: [{}] }],
  FileDiff: class {
    constructor(options: { themeType: string }) {
      renders.diff(options);
    }
    render() {
      return true;
    }
    cleanUp() {}
  },
}));
vi.mock("mermaid", () => ({
  default: {
    initialize: (options: { theme: string }) => renders.mermaid(options),
    render: async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>',
    }),
  },
}));

describe("rich-content presentation theme", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.style.removeProperty("color-scheme");
  });

  it("uses the layout setting through SSR, stored hydration, and light/dark switches while html stays dark", async () => {
    vi.resetModules();
    window.localStorage.setItem(
      PRESENTATION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        settings: { ...DEFAULT_PRESENTATION_SETTINGS, theme: "editorial-archive" },
      }),
    );
    document.documentElement.style.colorScheme = "dark";
    const { useContentTheme } = await import("../../../app/components/content/useContentTheme.ts");
    const { usePresentationSettings } =
      await import("../../../app/composables/usePresentationSettings.ts");
    const Harness = defineComponent({
      setup() {
        const presentation = usePresentationSettings();
        const theme = useContentTheme();
        return () =>
          h("div", { class: "app-root", "data-theme": presentation.settings.theme }, [
            h("output", theme.value),
            h("button", { onClick: () => presentation.setTheme("quiet-precision") }, "Quiet"),
            h("button", { onClick: () => presentation.setTheme("midnight-glass") }, "Midnight"),
            h("button", { onClick: () => presentation.setTheme("editorial-archive") }, "Editorial"),
          ]);
      },
    });
    expect(await renderToString(createSSRApp(Harness))).toContain("<output>dark</output>");
    const wrapper = mount(Harness, { attachTo: document.body });
    await nextTick();
    expect(wrapper.attributes("data-theme")).toBe("editorial-archive");
    expect(wrapper.get("output").text()).toBe("light");
    // oxlint-disable no-await-in-loop -- Each theme change must settle before the next selection.
    for (const [index, expected] of [
      [0, "light"],
      [1, "dark"],
      [2, "light"],
    ] as const) {
      await wrapper.findAll("button")[index].trigger("click");
      await flushPromises();
      expect(wrapper.get("output").text()).toBe(expected);
      expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark");
    }
    // oxlint-enable no-await-in-loop
    wrapper.unmount();
  });

  it("rerenders mounted diff and Mermaid previews when the application theme changes", async () => {
    vi.resetModules();
    const { usePresentationSettings } =
      await import("../../../app/composables/usePresentationSettings.ts");
    const { default: DiffBlock } =
      await import("../../../app/components/content/DiffBlock.client.vue");
    const { default: MermaidBlock } =
      await import("../../../app/components/content/MermaidBlock.vue");
    const Harness = defineComponent({
      setup() {
        const presentation = usePresentationSettings();
        return () =>
          h("div", { class: "app-root", "data-theme": presentation.settings.theme }, [
            h(DiffBlock, { source: "recorded patch", wrapped: false }),
            h(MermaidBlock, { source: "graph TD; A-->B" }),
            h(
              "button",
              {
                "data-set-theme": "light",
                onClick: () => presentation.setTheme("quiet-precision"),
              },
              "Light",
            ),
            h(
              "button",
              { "data-set-theme": "dark", onClick: () => presentation.setTheme("midnight-glass") },
              "Dark",
            ),
          ]);
      },
    });
    const wrapper = mount(Harness, { attachTo: document.body });
    await wrapper.get('[aria-label="Preview Mermaid diagram"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(renders.diff).toHaveBeenLastCalledWith(expect.objectContaining({ themeType: "dark" }));
    expect(renders.mermaid).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    const diffElement = wrapper.get(".rich-diff").element;
    const mermaidElement = wrapper.get(".rich-mermaid").element;
    await wrapper.get('[data-set-theme="light"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(renders.diff).toHaveBeenLastCalledWith(expect.objectContaining({ themeType: "light" }));
    expect(renders.mermaid).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "neutral" }));
    await wrapper.get('[data-set-theme="dark"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(renders.diff).toHaveBeenLastCalledWith(expect.objectContaining({ themeType: "dark" }));
    expect(renders.mermaid).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(wrapper.get(".rich-diff").element).toBe(diffElement);
    expect(wrapper.get(".rich-mermaid").element).toBe(mermaidElement);
    wrapper.unmount();
  });
});
