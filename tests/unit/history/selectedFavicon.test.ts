import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { getCachedFaviconFile } from "#server/cache/contentStore.ts";
import { openCacheDatabase } from "#server/cache/database.ts";
import { prepareHistoryPresentation } from "#server/history/historyPresentation.ts";
import { InvalidationBus } from "#server/live/invalidationBus.ts";
import { LiveReconciler } from "#server/live/reconciler.ts";

it("acquires and registers selected progressive favicons through real cache/completion paths without startup enrichment", async () => {
  const root = await mkdtemp(join(tmpdir(), "selected-favicon-"));
  const database = openCacheDatabase(":memory:");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const client = vi.fn(async (url: URL) => ({
    url,
    status: url.origin === "https://example.com" && url.pathname === "/favicon.ico" ? 200 : 404,
    contentType: "image/png",
    body: png,
  }));
  const bus = new InvalidationBus();
  const listener = vi.fn();
  const unsubscribe = bus.subscribe(listener);
  const reconciler = new LiveReconciler({
    bus,
    database,
    codexHome: join(root, "home"),
    cacheDir: join(root, "cache"),
    faviconClient: client,
    fetchFavicons: true,
  });
  const query = {
    threadId: "thread",
    historyEpoch: "epoch",
    contentRevision: "revision",
    physicalRolloutId: "physical",
    turnId: "turn",
    itemId: "item",
    markdown: "[Example](https://example.com/page) [Again](https://example.com/another)",
  };
  const context = {
    cacheScope: root,
    storeEmbeddedMedia: async () => undefined,
    onDocument: (document: Parameters<LiveReconciler["scheduleDocumentFavicons"]>[0]) =>
      reconciler.scheduleDocumentFavicons(document),
  };
  try {
    expect(client).not.toHaveBeenCalled();
    await prepareHistoryPresentation(query, undefined, context);
    expect(reconciler.faviconOrigin(Buffer.from("https://example.com").toString("base64url"))).toBe(
      "https://example.com",
    );
    await vi.waitFor(() =>
      expect(getCachedFaviconFile(database, "https://example.com")?.mimeType).toBe("image/png"),
    );
    await vi.waitFor(() =>
      expect(listener.mock.calls.some(([event]) => event.type === "favicon.updated")).toBe(true),
    );
    const fetched = client.mock.calls.length;
    await prepareHistoryPresentation(query, undefined, context);
    await vi.waitFor(() =>
      expect(getCachedFaviconFile(database, "https://example.com")).not.toBeNull(),
    );
    expect(client).toHaveBeenCalledTimes(fetched);
    expect(database.prepare("SELECT count(*) AS count FROM sessions").get()?.["count"]).toBe(0);
  } finally {
    await reconciler.close();
    unsubscribe();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
