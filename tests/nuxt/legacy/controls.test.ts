import { mountSuspended as mount } from "@nuxt/test-utils/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import UiButton from "~/components/ui/UiButton.vue";
import UiDisclosure from "~/components/ui/UiDisclosure.vue";
import UiMenu from "~/components/ui/UiMenu.vue";
import UiTabs from "~/components/ui/UiTabs.vue";
import UiTextField from "~/components/ui/UiTextField.vue";
import UiTooltip from "~/components/ui/UiTooltip.vue";

describe("Task 9 UI controls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a button label readable while exposing loading and result states", async () => {
    const wrapper = await mount(UiButton, {
      props: { state: "loading" },
      slots: { default: "Save preferences" },
    });
    const button = wrapper.get("button");

    expect(button.attributes("aria-busy")).toBe("true");
    expect(button.attributes()).toHaveProperty("disabled");
    expect(button.text()).toContain("Save preferences");

    await wrapper.setProps({ state: "error" });
    expect(button.attributes("data-state")).toBe("error");
    expect(button.attributes("aria-busy")).toBeUndefined();
    expect(button.attributes()).not.toHaveProperty("disabled");

    await wrapper.setProps({ state: "success" });
    expect(button.attributes("data-state")).toBe("success");
  });

  it("shows tooltips after a pointer pause, immediately on focus, and dismisses on Escape", async () => {
    vi.useFakeTimers();
    const wrapper = await mount(UiTooltip, {
      props: { text: "Open settings" },
      slots: { default: '<button type="button">Settings</button>' },
    });
    await wrapper.trigger("pointerenter");
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(799);
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper.get('[role="tooltip"]').text()).toBe("Open settings");

    await wrapper.trigger("pointerleave");
    await wrapper.trigger("focusin");
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);

    await wrapper.trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
  });

  it("associates helper and error content and emits edited field values", async () => {
    const wrapper = await mount(UiTextField, {
      props: {
        id: "codex-home",
        label: "Codex home",
        modelValue: "C:\\Users\\dev\\.codex",
        helper: "The viewer reads this directory without changing it.",
      },
    });
    const input = wrapper.get("input");

    expect(input.attributes("aria-describedby")).toBe("codex-home-message");
    expect(wrapper.get(".ui-field__message").text()).toContain("reads this directory");

    await wrapper.setProps({ state: "error", message: "Choose an existing Codex home." });
    expect(input.attributes("aria-invalid")).toBe("true");
    expect(wrapper.get(".ui-field__message").text()).toBe("Choose an existing Codex home.");

    await input.setValue("D:\\Codex");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["D:\\Codex"]);
  });

  it("wraps every tab-navigation key while skipping disabled items and ignoring unrelated keys", async () => {
    const wrapper = await mount(UiTabs, {
      attachTo: document.body,
      props: {
        label: "Views",
        modelValue: "first",
        items: [
          { value: "first", label: "First" },
          { value: "disabled", label: "Disabled", disabled: true },
          { value: "last", label: "Last" },
        ],
      },
    });
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs[0]!.attributes("aria-selected")).toBe("true");
    expect(tabs[2]!.attributes("tabindex")).toBe("-1");
    await tabs[0]!.trigger("keydown", { key: "ArrowLeft" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["last"]);
    expect(document.activeElement).toBe(tabs[2]!.element);
    await tabs[2]!.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["first"]);
    await tabs[0]!.trigger("keydown", { key: "ArrowRight" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["last"]);
    await tabs[2]!.trigger("keydown", { key: "ArrowUp" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["first"]);
    await tabs[0]!.trigger("keydown", { key: "End" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["last"]);
    await tabs[2]!.trigger("keydown", { key: "Home" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["first"]);
    const count = wrapper.emitted("update:modelValue")!.length;
    await tabs[0]!.trigger("keydown", { key: "Escape" });
    await tabs[1]!.trigger("keydown", { key: "ArrowRight" });
    expect(wrapper.emitted("update:modelValue")!).toHaveLength(count);
    wrapper.unmount();
  });

  it("renders a disclosure label and dismisses an opened menu with Escape", async () => {
    const disclosure = await mount(UiDisclosure, {
      props: { label: "Cache diagnostics" },
      slots: { default: "No parser diagnostics." },
    });
    expect(disclosure.get("summary").text()).toContain("Cache diagnostics");

    const menu = await mount(UiMenu, {
      props: { label: "More actions" },
      slots: { default: '<button role="menuitem" type="button">Retry</button>' },
    });
    await menu.get("button").trigger("click");
    expect(menu.get('[role="menu"]').text()).toContain("Retry");

    await menu.trigger("keydown", { key: "Escape" });
    expect(menu.find('[role="menu"]').exists()).toBe(false);
  });
});
