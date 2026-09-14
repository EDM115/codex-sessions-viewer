import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DiffBlock from "../../../app/components/content/DiffBlock.client.vue";

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{
    cleanUp: ReturnType<typeof vi.fn>;
    setOptions: ReturnType<typeof vi.fn>;
    rerender: ReturnType<typeof vi.fn>;
  }>,
  parse: vi.fn<(source: string) => Array<{ files: Array<{ marker: string }> }>>((source: string) =>
    source === "invalid" ? [] : [{ files: source.split("|").map((marker) => ({ marker })) }],
  ),
}));
vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: mocks.parse,
  FileDiff: class {
    cleanUp = vi.fn<() => void>();
    setOptions = vi.fn<(options: { overflow: string }) => void>();
    rerender = vi.fn<() => void>();
    constructor() {
      mocks.instances.push(this);
    }
    render({
      fileDiff,
      fileContainer,
    }: {
      fileDiff: { marker: string };
      fileContainer: HTMLElement;
    }) {
      fileContainer.textContent = fileDiff.marker;
      return true;
    }
  },
}));
enableAutoUnmount(afterEach);
beforeEach(() => {
  mocks.instances.length = 0;
});
async function settle() {
  await vi.dynamicImportSettled();
  await flushPromises();
}

describe("complete reactive diff previews", () => {
  it("renders every file, updates all wrapping options and releases each old instance exactly once", async () => {
    const wrapper = mount(DiffBlock, {
      props: { source: "first: new first|second: new second", wrapped: false },
    });
    await settle();
    expect(wrapper.findAll("[data-diff-file]").map((node) => node.text())).toEqual([
      "first: new first",
      "second: new second",
    ]);
    await wrapper.setProps({ wrapped: true });
    for (const instance of mocks.instances) {
      expect(instance.setOptions).toHaveBeenCalledWith({ overflow: "wrap" });
      expect(instance.rerender).toHaveBeenCalledOnce();
    }
    const old = [...mocks.instances];
    await wrapper.setProps({ source: "first: new first|second: latest second" });
    await settle();
    expect(wrapper.text()).toContain("latest second");
    expect(wrapper.text()).not.toContain("second: new second");
    for (const instance of old) {
      expect(instance.cleanUp).toHaveBeenCalledOnce();
    }
    wrapper.unmount();
    for (const instance of mocks.instances) {
      expect(instance.cleanUp).toHaveBeenCalledOnce();
    }
  });

  it("removes stale successful output through valid, invalid, valid changes", async () => {
    const wrapper = mount(DiffBlock, { props: { source: "old file", wrapped: false } });
    await settle();
    await wrapper.setProps({ source: "invalid" });
    await settle();
    expect(wrapper.get("pre").text()).toBe("invalid");
    expect(wrapper.findAll("[data-diff-file]")).toHaveLength(0);
    await wrapper.setProps({ source: "restored first|restored second" });
    await settle();
    expect(wrapper.find("pre").exists()).toBe(false);
    expect(wrapper.text()).toContain("restored second");
  });

  it("discards a superseded source while its lazy module is being loaded", async () => {
    const wrapper = mount(DiffBlock, {
      props: { source: "stale first|stale second", wrapped: false },
    });
    await wrapper.setProps({ source: "current first|current second" });
    await settle();
    await vi.waitFor(() => expect(wrapper.attributes("data-state")).toBe("ready"));
    expect(wrapper.text()).toContain("current second");
    expect(wrapper.text()).not.toContain("stale");
    expect(mocks.instances).toHaveLength(2);
  });
});
