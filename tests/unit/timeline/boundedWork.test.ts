import { describe, expect, it } from "vitest";

import { createBoundedWorkQueue } from "#shared/timeline/boundedWork.ts";

describe("expensive presentation work", () => {
  it("bounds running work and discards cancelled queued work before it starts", async () => {
    const queue = createBoundedWorkQueue(2);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const job = async () => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return "done";
    };
    const first = queue.run(job);
    const second = queue.run(job);
    const controller = new AbortController();
    let cancelledRan = false;
    const cancelled = queue
      .run(async () => {
        cancelledRan = true;
      }, controller.signal)
      .catch(() => "aborted");
    controller.abort();
    releases.forEach((release) => release());
    expect(await Promise.all([first, second, cancelled])).toEqual(["done", "done", "aborted"]);
    expect(peak).toBe(2);
    expect(cancelledRan).toBe(false);
    expect(queue.active).toBe(0);
    expect(queue.pending).toBe(0);
  });
});
