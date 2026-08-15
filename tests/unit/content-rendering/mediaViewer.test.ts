import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import MediaViewer from "../../../app/components/media/MediaViewer.vue";

describe("Task 11 fullscreen media viewer", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses a modal surface, makes the workbench inert, zooms, resets, and closes on Escape", async () => {
    const background = document.createElement("main");
    background.innerHTML = '<button type="button">Open image</button>';
    document.body.append(background);
    const wrapper = mount(MediaViewer, {
      attachTo: document.body,
      props: {
        background,
        item: {
          kind: "image",
          src: "/api/assets/diagram/content",
          alt: "Architecture diagram",
          filename: "diagram.png",
          mimeType: "image/png",
          width: 640,
          height: 360,
        },
      },
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.get("dialog").attributes("aria-modal")).toBe("true");
    expect(background.inert).toBe(true);
    expect(document.activeElement).toBe(wrapper.get(".media-viewer__stage").element);

    await wrapper.get('button[aria-label="Zoom in"]').trigger("click");
    expect(wrapper.get(".media-viewer__content").attributes("style")).toContain("scale(1.25)");
    await wrapper.get('button[aria-label="Reset view"]').trigger("click");
    expect(wrapper.get(".media-viewer__content").attributes("style")).toContain("scale(1)");

    await wrapper.get("dialog").trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
    expect(background.inert).toBe(false);
  });

  it("disables image clipboard when the browser cannot write ClipboardItem values", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("ClipboardItem", undefined);
    const wrapper = mount(MediaViewer, {
      props: {
        item: {
          kind: "image",
          src: "/assets/diagram.png",
          alt: "Diagram",
          filename: "diagram.png",
          mimeType: "image/png",
          width: null,
          height: null,
        },
      },
    });

    const copy = wrapper.get('button[aria-label="Copy image unavailable"]');
    expect(copy.attributes()).toHaveProperty("disabled");
    expect(copy.attributes("aria-describedby")).toBeTruthy();
    const copyTooltip = wrapper
      .findAll(".ui-tooltip")
      .find((candidate) => candidate.find('button[aria-label="Copy image unavailable"]').exists());
    if (copyTooltip === undefined) {
      throw new Error("Expected the unavailable clipboard control tooltip.");
    }
    await copyTooltip.trigger("pointerenter");
    await vi.advanceTimersByTimeAsync(800);
    expect(wrapper.text()).toContain("Image clipboard is unavailable in this browser");
  });
});
