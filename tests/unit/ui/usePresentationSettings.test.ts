// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, defineComponent, h, nextTick } from "vue";
import { renderToString } from "vue/server-renderer";

import {
  DEFAULT_PRESENTATION_SETTINGS,
  PRESENTATION_SETTINGS_STORAGE_KEY,
} from "../../../shared/types/settings.ts";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

async function loadHarness() {
  const { usePresentationSettings } =
    await import("../../../app/composables/usePresentationSettings.ts");

  const Harness = defineComponent({
    setup() {
      const presentation = usePresentationSettings();
      return () =>
        h("section", { "data-theme": presentation.settings.theme }, [
          h("output", { "data-testid": "hydrated" }, String(presentation.hydrated.value)),
          h(
            "button",
            {
              type: "button",
              onClick: () => presentation.setTheme("quiet-precision"),
            },
            "Use Quiet Precision",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () => presentation.setWrapCode(true),
            },
            "Wrap code",
          ),
        ]);
    },
  });

  return { Harness };
}

describe("usePresentationSettings", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    vi.resetModules();
  });

  it("keeps stored preferences out of SSR markup and applies them after mount", async () => {
    window.localStorage.setItem(
      PRESENTATION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        settings: {
          ...DEFAULT_PRESENTATION_SETTINGS,
          theme: "editorial-archive",
        },
      }),
    );
    const { Harness } = await loadHarness();

    const html = await renderToString(createSSRApp(Harness));

    expect(html).toContain('data-theme="midnight-glass"');
    expect(html).toContain(">false<");

    const wrapper = mount(Harness);
    await nextTick();

    expect(wrapper.attributes("data-theme")).toBe("editorial-archive");
    expect(wrapper.get('[data-testid="hydrated"]').text()).toBe("true");
  });

  it("migrates invalid storage and persists named updates in the current envelope", async () => {
    window.localStorage.setItem(
      PRESENTATION_SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: "laser-grid", wrapCode: "yes" }),
    );
    const { Harness } = await loadHarness();
    const wrapper = mount(Harness);
    await nextTick();

    expect(wrapper.attributes("data-theme")).toBe("midnight-glass");

    await wrapper.get("button").trigger("click");
    const secondButton = wrapper.findAll("button")[1];
    if (secondButton === undefined) {
      throw new Error("Expected the second settings action.");
    }
    await secondButton.trigger("click");

    expect(
      JSON.parse(window.localStorage.getItem(PRESENTATION_SETTINGS_STORAGE_KEY) ?? "null"),
    ).toEqual({
      version: 1,
      settings: {
        ...DEFAULT_PRESENTATION_SETTINGS,
        theme: "quiet-precision",
        wrapCode: true,
      },
    });
  });

  it("shares readonly presentation state across consumers on the client", async () => {
    const { usePresentationSettings } =
      await import("../../../app/composables/usePresentationSettings.ts");
    const First = defineComponent({
      setup() {
        const presentation = usePresentationSettings();
        return () =>
          h(
            "button",
            { type: "button", onClick: () => presentation.setLiveFollow(false) },
            String(presentation.settings.liveFollow),
          );
      },
    });
    const Second = defineComponent({
      setup() {
        const presentation = usePresentationSettings();
        return () => h("output", String(presentation.settings.liveFollow));
      },
    });
    const Pair = defineComponent({
      setup: () => () => h("div", [h(First), h(Second)]),
    });
    const wrapper = mount(Pair);
    await nextTick();

    await wrapper.get("button").trigger("click");

    expect(wrapper.get("output").text()).toBe("false");
  });
});
