import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import MediaViewer from "../../../app/components/media/MediaViewer.vue";
import { useMediaViewer } from "../../../app/composables/useMediaViewer.ts";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

describe("Task 11 fullscreen media viewer", () => {
  afterEach(() => {
    document.body.replaceChildren();
    if (originalClipboard === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
    } else {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("restores focus to a virtualized replacement of its opener", async () => {
    const message = document.createElement("article");
    message.dataset["messageId"] = "message-1";
    const opener = document.createElement("button");
    opener.setAttribute("aria-label", "Open Mermaid diagram");
    message.append(opener);
    document.body.append(message);
    opener.focus();
    const viewer = useMediaViewer();
    viewer.open({
      kind: "svg",
      alt: "Diagram",
      filename: "diagram.svg",
      height: null,
      mimeType: "image/svg+xml",
      source: "graph TD",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width: null,
    });

    const replacementMessage = message.cloneNode(false) as HTMLElement;
    const replacement = opener.cloneNode(true) as HTMLButtonElement;
    replacementMessage.append(replacement);
    message.replaceWith(replacementMessage);
    viewer.close();
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(document.activeElement).toBe(replacement);
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

  it("copies and downloads cached images while reporting cache read failures", async () => {
    class TestClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    const write = vi.fn(async (_items: TestClipboardItem[]) => undefined);
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/png" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const wrapper = mount(MediaViewer, {
      props: {
        item: {
          kind: "image",
          src: "/api/assets/image/content",
          alt: "",
          filename: "cached.png",
          mimeType: "image/png",
          width: null,
          height: null,
        },
      },
    });

    expect(wrapper.get(".media-viewer__title").text()).toBe("cached.png");
    await wrapper.get('button[aria-label="Copy image"]').trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/image/content");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toHaveLength(1);
    await expect(write.mock.calls[0]![0][0]!.items["image/png"]!.text()).resolves.toBe("image");
    expect(wrapper.get('button[aria-label="Copied: Copy image"]').attributes("data-state")).toBe(
      "success",
    );

    await wrapper.get('button[aria-label="Download image"]').trigger("click");
    expect(click).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      blob: async () => new Blob([], { type: "image/png" }),
    });
    await wrapper.get('button[aria-label="Copied: Copy image"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('button[aria-label="Copy image"]').attributes("data-state")).toBe("error");
    expect(write).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("supports SVG download, PNG rasterization, wheel zoom, drag, pinch, and backdrop close", async () => {
    class LoadedImage {
      naturalWidth = 0;
      naturalHeight = 0;
      private load: (() => void) | null = null;

      addEventListener(type: string, listener: () => void): void {
        if (type === "load") {
          this.load = listener;
        }
      }

      set src(_value: string) {
        queueMicrotask(() => this.load?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    const drawImage = vi.fn();
    const nativeCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string, options?: ElementCreationOptions) => {
        const element = nativeCreateElement(tagName, options);
        if (tagName === "canvas") {
          Object.defineProperty(element, "getContext", {
            configurable: true,
            value: () => ({ drawImage }),
          });
          Object.defineProperty(element, "toBlob", {
            configurable: true,
            value: (callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" })),
          });
        }
        return element;
      },
    );
    const wrapper = mount(MediaViewer, {
      props: {
        item: {
          kind: "svg",
          svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
          alt: "Diagram",
          filename: "diagram.svg",
          width: null,
          height: null,
        },
      },
    });

    await wrapper.get('button[aria-label="Download SVG"]').trigger("click");
    expect(createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/svg+xml" }),
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");

    await wrapper.get('button[aria-label="Download PNG"]').trigger("click");
    await flushPromises();
    expect(drawImage).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "image/png" }),
    );

    const stage = wrapper.get(".media-viewer__stage");
    await stage.trigger("wheel", { deltaY: -1 });
    expect(wrapper.get(".media-viewer__content").attributes("style")).toContain("scale(1.25)");
    await stage.trigger("wheel", { deltaY: 1 });
    await wrapper.get('button[aria-label="Original size"]').trigger("click");
    await stage.trigger("pointermove", { pointerId: 99, clientX: 10, clientY: 10 });
    await stage.trigger("pointerdown", { pointerId: 1, clientX: 10, clientY: 15 });
    await stage.trigger("pointermove", { pointerId: 1, clientX: 25, clientY: 35 });
    expect(wrapper.get(".media-viewer__content").attributes("style")).toContain(
      "translate3d(15px, 20px",
    );
    await stage.trigger("pointerdown", { pointerId: 2, clientX: 50, clientY: 15 });
    await stage.trigger("pointermove", { pointerId: 2, clientX: 90, clientY: 15 });
    const pinchedScale = Number(
      wrapper
        .get(".media-viewer__content")
        .attributes("style")
        .match(/scale\(([^)]+)\)/u)?.[1],
    );
    // Pointer distance changes from sqrt(25² + 20²) to sqrt(65² + 20²).
    expect(pinchedScale).toBeCloseTo(Math.sqrt(4_625 / 1_025), 6);
    await stage.trigger("pointerup", { pointerId: 2 });
    await stage.trigger("pointercancel", { pointerId: 1 });

    await wrapper.get("dialog").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.get("dialog").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(downloads).toEqual(expect.arrayContaining(["diagram.svg", "diagram.png"]));
    wrapper.unmount();
  });

  it("keeps the SVG download available when PNG rasterization fails", async () => {
    class FailedImage {
      private fail: (() => void) | null = null;

      addEventListener(type: string, listener: () => void): void {
        if (type === "error") {
          this.fail = listener;
        }
      }

      set src(_value: string) {
        queueMicrotask(() => this.fail?.());
      }
    }
    vi.stubGlobal("Image", FailedImage);
    const wrapper = mount(MediaViewer, {
      props: {
        item: {
          kind: "svg",
          svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
          alt: "Diagram",
          filename: "diagram.svg",
          width: 10,
          height: 10,
        },
      },
    });

    await wrapper.get('button[aria-label="Download PNG"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain("PNG download failed");
    expect(wrapper.get('button[aria-label="Download SVG"]')).toBeTruthy();
    wrapper.unmount();
  });
});
