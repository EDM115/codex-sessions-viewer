import { createServer } from "node:http";

import { createApp, createEventStream, defineEventHandler, toNodeListener } from "h3";
import { describe, expect, it, vi } from "vitest";

import {
  connectInvalidationStream,
  sendInvalidationStream,
} from "../../../server/live/eventStream.ts";
import { InvalidationBus } from "../../../server/live/invalidationBus.ts";
import type { ViewerInvalidation } from "../../../shared/types/repository.ts";

describe("live invalidation bus", () => {
  it("validates compact events and removes disconnected listeners immediately", () => {
    const bus = new InvalidationBus();
    const listener = vi.fn<(event: ViewerInvalidation) => void>();
    const unsubscribe = bus.subscribe(listener);
    const event = {
      type: "session.updated" as const,
      ids: ["session-1", "turn-4"],
      revision: "sha256:revision-2",
    };

    expect(bus.listenerCount).toBe(1);
    expect(bus.publish(event)).toBe(1);
    expect(listener).toHaveBeenCalledWith(event);

    unsubscribe();
    unsubscribe();
    expect(bus.listenerCount).toBe(0);
    expect(bus.publish(event)).toBe(2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("unsubscribes an SSE listener as soon as its stream closes", () => {
    const bus = new InvalidationBus();
    const closeCallbacks: Array<() => void> = [];
    const stream = {
      push: vi.fn<() => Promise<void>>(async () => undefined),
      send: vi.fn<() => Promise<void>>(async () => undefined),
      close: vi.fn<() => Promise<void>>(async () => undefined),
      onClosed(callback: () => void) {
        closeCallbacks.push(callback);
      },
    };
    connectInvalidationStream(bus, stream);
    expect(bus.listenerCount).toBe(1);

    bus.publish({ type: "library.updated", ids: ["session-1"], revision: "live:1" });
    expect(stream.push).toHaveBeenCalledOnce();
    const onClosed = closeCallbacks[0];
    if (onClosed === undefined) {
      throw new Error("The stream did not register its close callback.");
    }
    onClosed();
    expect(bus.listenerCount).toBe(0);
  });

  it("keeps the SSE listener until a handed-off stream actually closes", async () => {
    const bus = new InvalidationBus();
    const closeCallbacks: Array<() => void> = [];
    const stream = {
      push: async () => undefined,
      send: async () => undefined,
      close: async () => undefined,
      onClosed(callback: () => void) {
        closeCallbacks.push(callback);
      },
    };

    await sendInvalidationStream(bus, stream);

    expect(bus.listenerCount).toBe(1);
    const onClosed = closeCallbacks[0];
    if (onClosed === undefined) {
      throw new Error("The stream did not register its close callback.");
    }
    onClosed();
    expect(bus.listenerCount).toBe(0);
  });

  it("delivers invalidations through the installed H3 event stream", async () => {
    const bus = new InvalidationBus();
    let resolveConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const app = createApp().use(
      defineEventHandler(async (event) => {
        const stream = createEventStream(event);
        resolveConnected?.();
        await sendInvalidationStream(bus, stream);
      }),
    );
    const server = createServer(toNodeListener(app));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const abort = new AbortController();

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("The SSE fixture did not bind a TCP port.");
      }
      const responsePromise = fetch(`http://127.0.0.1:${String(address.port)}`, {
        signal: abort.signal,
      });
      await connected;
      bus.publish({
        type: "session.updated",
        ids: ["session-1", "turn-2"],
        revision: "sha256:transport",
      });
      const response = await responsePromise;
      const chunk = await response.body?.getReader().read();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frame = new TextDecoder().decode(chunk?.value);
      expect(frame).toContain("event: session.updated");
      expect(frame).toContain("id: sha256:transport");
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      expect(JSON.parse(data!.slice(6))).toEqual({
        type: "session.updated",
        ids: ["session-1", "turn-2"],
        revision: "sha256:transport",
      });
    } finally {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
