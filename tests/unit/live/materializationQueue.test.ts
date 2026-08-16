import { describe, expect, it, vi } from "vitest";

import {
  MaterializationQueue,
  type MaterializationPriority,
} from "../../../server/live/materializationQueue.ts";
import type { PreparationResult } from "../../../shared/types/library.ts";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

function ready(id: string): PreparationResult {
  return { id, state: "ready", error: null };
}

describe("MaterializationQueue", () => {
  it("runs one worker at a time and lets open work overtake queued visible work", async () => {
    const gates = new Map<string, Deferred>();
    const started: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const queue = new MaterializationQueue(async (id) => {
      started.push(id);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const gate = deferred();
      gates.set(id, gate);
      await gate.promise;
      concurrent -= 1;
      return ready(id);
    });

    const visible = queue.enqueue(["visible-a", "visible-b"], "visible", "viewport");
    const opened = queue.enqueue(["opened"], "open", "route");
    expect(started).toEqual(["visible-a"]);

    gates.get("visible-a")?.resolve();
    await vi.waitFor(() => expect(started).toEqual(["visible-a", "opened"]));
    gates.get("opened")?.resolve();
    await vi.waitFor(() => expect(started).toEqual(["visible-a", "opened", "visible-b"]));
    gates.get("visible-b")?.resolve();

    await expect(Promise.all([visible, opened])).resolves.toEqual([
      [ready("visible-a"), ready("visible-b")],
      [ready("opened")],
    ]);
    expect(maxConcurrent).toBe(1);
    await queue.close();
  });

  it("deduplicates owners, upgrades priority, and cancels only unowned queued work", async () => {
    const activeGate = deferred();
    const started: Array<{ id: string; priority: MaterializationPriority }> = [];
    const worker = vi.fn<
      (id: string, priority: MaterializationPriority) => Promise<PreparationResult>
    >(async (id, priority) => {
      started.push({ id, priority });
      if (id === "active") {
        await activeGate.promise;
      }
      return ready(id);
    });
    const queue = new MaterializationQueue(worker);

    const active = queue.enqueue(["active"], "visible", "viewport");
    const sharedVisible = queue.enqueue(["shared"], "visible", "viewport");
    const sharedOpen = queue.enqueue(["shared"], "open", "route");
    const cancelled = queue.enqueue(["cancelled"], "deep-search", "search-1");
    queue.cancelOwner("search-1");
    activeGate.resolve();

    await expect(cancelled).resolves.toEqual([
      { id: "cancelled", state: "cold", error: "Materialization was cancelled." },
    ]);
    await expect(Promise.all([active, sharedVisible, sharedOpen])).resolves.toEqual([
      [ready("active")],
      [ready("shared")],
      [ready("shared")],
    ]);
    expect(worker.mock.calls.map(([id]) => id)).toEqual(["active", "shared"]);
    expect(started).toEqual([
      { id: "active", priority: "visible" },
      { id: "shared", priority: "open" },
    ]);
    await queue.close();
  });

  it("lets active work finish while close settles queued callers", async () => {
    const gate = deferred();
    const queue = new MaterializationQueue(async (id) => {
      await gate.promise;
      return ready(id);
    });
    const active = queue.enqueue(["active"], "visible");
    const queued = queue.enqueue(["queued"], "visible");
    const closing = queue.close();

    await expect(queued).resolves.toEqual([
      { id: "queued", state: "cold", error: "Materialization queue is closed." },
    ]);
    gate.resolve();
    await expect(active).resolves.toEqual([ready("active")]);
    await expect(closing).resolves.toBeUndefined();
  });
});
