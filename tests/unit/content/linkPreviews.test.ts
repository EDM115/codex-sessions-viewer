import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import {
  createFaviconHttpClient,
  type FaviconHttpClient,
  type FaviconHttpResponse,
} from "#server/content/favicons.ts";
import {
  LinkPreviewService,
  parseWebsiteMetadata,
  readPreviewImage,
} from "#server/content/linkPreviews.ts";
import { previewImageDimensions } from "#server/content/previewImage.ts";
import { canonicalWebsiteUrl } from "#shared/types/linkPreview.ts";

describe("website preview enrichment", () => {
  it("retires replaced imagery while retaining shared references across image, text and negative refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "preview-refresh-"));
    const database = openCacheDatabase(":memory:");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    let now = 1;
    let revision = 0;
    let mode: "image" | "text" | "negative" = "image";
    const service = new LinkPreviewService(database, root, {
      enabled: true,
      now: () => now,
      client: async (url) => {
        if (mode === "negative") {
          throw new Error("synthetic offline");
        }
        return {
          url,
          status: 200,
          contentType: url.pathname.endsWith(".png") ? "image/png" : "text/html",
          body: url.pathname.endsWith(".png")
            ? Buffer.concat([png, Buffer.from(String(revision))])
            : Buffer.from(
                `<title>Saved</title>${mode === "image" ? '<meta property="og:image" content="/image.png">' : ""}`,
              ),
        };
      },
    });
    try {
      const first = await service.resolve("https://example.com/a");
      const shared = await service.resolve("https://example.com/b");
      expect(shared.image?.sha256).toBe(first.image?.sha256);
      now += 600001;
      revision += 1;
      await service.resolve("https://example.com/a");
      expect(await readPreviewImage(root, first.image!)).not.toBeNull();
      expect((await readdir(root)).filter((name) => name.endsWith(".png"))).toHaveLength(2);
      now += 600001;
      revision += 1;
      await service.resolve("https://example.com/a");
      expect((await readdir(root)).filter((name) => name.endsWith(".png"))).toHaveLength(2);
      mode = "text";
      now += 600001;
      await service.resolve("https://example.com/b");
      expect(await readPreviewImage(root, first.image!)).toBeNull();
      expect((await readdir(root)).filter((name) => name.endsWith(".png"))).toHaveLength(1);
      mode = "negative";
      now += 600001;
      await service.resolve("https://example.com/a");
      expect((await readdir(root)).filter((name) => name.endsWith(".png"))).toHaveLength(0);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM website_previews").get()?.["count"],
      ).toBe(2);
    } finally {
      await service.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("evicts old imagery despite a corrupt retained payload and waits for aborted acquisitions before database release", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-preview-corrupt-"));
    const database = openCacheDatabase(":memory:");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    let now = 1;
    const service = new LinkPreviewService(database, root, {
      enabled: true,
      now: () => now,
      client: async (url) => ({
        url,
        status: 200,
        contentType: url.pathname.endsWith(".png") ? "image/png" : "text/html",
        body: url.pathname.endsWith(".png")
          ? png
          : Buffer.from(
              url.pathname === "/old"
                ? '<title>Saved</title><meta property="og:image" content="/image.png">'
                : "<title>New</title>",
            ),
      }),
    });
    let finish!: (response: FaviconHttpResponse) => void;
    let started!: () => void;
    const acquiring = new Promise<void>((resolve) => {
      started = resolve;
    });
    const closingService = new LinkPreviewService(database, root, {
      enabled: true,
      client: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      const saved = await service.resolve("https://example.com/old");
      expect(saved.image).not.toBeNull();
      const insert = database.prepare("INSERT INTO website_previews VALUES (?, ?, ?)");
      for (let index = 0; index < 127; index += 1) {
        insert.run(`https://example.com/seed-${index}`, "{}", index + 2);
      }
      insert.run("https://example.com/corrupt", "{broken}", 500);
      now = 600;
      await service.resolve("https://example.com/new");
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM website_previews").get()?.["count"],
      ).toBe(128);
      expect(await service.cached("https://example.com/old")).toBeNull();
      expect(await service.cached("https://example.com/corrupt")).toBeNull();
      expect(await readPreviewImage(root, saved.image!)).toBeNull();
      const pending = closingService.resolve("https://example.com/pending");
      const rejected = pending.then(
        () => ({ status: "fulfilled" }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      await acquiring;
      const closing = closingService.close();
      finish({
        url: new URL("https://example.com/pending"),
        status: 200,
        contentType: "text/html",
        body: Buffer.from("<title>Late result</title>"),
      });
      await closing;
      expect(await rejected).toMatchObject({ status: "rejected", error: { name: "AbortError" } });
      expect(
        database
          .prepare("SELECT 1 FROM website_previews WHERE url = ?")
          .get("https://example.com/pending"),
      ).toBeUndefined();
    } finally {
      await closingService.close();
      await service.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "bounds saved negative and mixed results (mixed=%s) and retains retry ownership",
    async (mixed) => {
      const root = await mkdtemp(join(tmpdir(), "viewer-preview-bound-"));
      const database = openCacheDatabase(":memory:");
      let now = 1_700_000_000_000;
      const client = vi.fn<FaviconHttpClient>(async (url: URL) => {
        if (!mixed || Number(url.pathname.slice(1)) % 2 === 0) {
          throw new Error("offline");
        }
        return {
          url,
          status: 200,
          contentType: "text/html",
          body: Buffer.from("<title>Saved</title>"),
        };
      });
      const service = new LinkPreviewService(database, root, {
        enabled: true,
        client,
        now: () => now,
      });
      try {
        database
          .prepare("INSERT INTO website_previews VALUES (?, ?, ?)")
          .run("https://example.com/corrupt", "{broken}", now - 1);
        for (let index = 0; index < 130; index += 1) {
          now += 1;
          // oxlint-disable-next-line no-await-in-loop -- Exercise persistent retention after each settled acquisition
          await service.resolve(`https://example.com/${index}`);
        }
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM website_previews").get()?.["count"],
        ).toBe(128);
        expect(await service.cached("https://example.com/0")).toBeNull();
        expect(await service.cached("https://example.com/128")).toMatchObject({
          availability: "unavailable",
          retryAt: new Date(now - 1 + 30000).toISOString(),
        });
        const calls = client.mock.calls.length;
        await service.resolve("https://example.com/128");
        expect(client).toHaveBeenCalledTimes(calls);
        now += 30001;
        await service.resolve("https://example.com/128");
        expect(client).toHaveBeenCalledTimes(calls + 1);
        await service.close();
        await expect(service.resolve("https://example.com/closed")).rejects.toThrow(
          "preview.closed",
        );
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM website_previews").get()?.["count"],
        ).toBe(128);
      } finally {
        await service.close();
        database.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("pins every redirect destination and refuses mixed public/private DNS before the next HTTP request", async () => {
    const request = vi.fn(async (url: URL, pinned: { address: string }) => ({
      url,
      status: 302,
      contentType: null,
      body: Buffer.alloc(0),
      location: "https://private.example.com/next",
      pinned,
    }));
    const lookup = vi.fn(async (host: string) =>
      host === "example.com"
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [
            { address: "93.184.216.34", family: 4 as const },
            { address: "127.0.0.1", family: 4 as const },
          ],
    );
    const client = createFaviconHttpClient({ request, lookup });
    await expect(
      client(new URL("https://example.com/page"), {
        maxBytes: 1024,
        accept: "text/html",
        validateUrl: (url) => {
          canonicalWebsiteUrl(url.href);
        },
      }),
    ).rejects.toThrow("non-public");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toEqual({ address: "93.184.216.34", family: 4 });
    expect(lookup.mock.calls.map(([host]) => host)).toEqual(["example.com", "private.example.com"]);
  });
  it("rejects unsupported HTML and raster decompression dimensions with bounded input", async () => {
    await expect(
      parseWebsiteMetadata(Buffer.alloc(1024 * 1024 + 1), "text/html", "https://example.com"),
    ).rejects.toThrow("unsupported");
    await expect(
      parseWebsiteMetadata(Buffer.from("plain"), "text/plain", "https://example.com"),
    ).rejects.toThrow("unsupported");
    const header = Buffer.alloc(24);
    header.writeUInt32BE(100000, 16);
    header.writeUInt32BE(100000, 20);
    expect(previewImageDimensions(header, "image/png")).toBeNull();
    header.writeUInt32BE(8192, 16);
    header.writeUInt32BE(8192, 20);
    expect(previewImageDimensions(header, "image/png")).toBeNull();
    header.writeUInt32BE(400, 16);
    header.writeUInt32BE(300, 20);
    expect(previewImageDimensions(header, "image/png")).toEqual({ width: 400, height: 300 });
  });
  it("retains path/query identity, drops fragments and rejects unsafe URL forms before transport", () => {
    expect(canonicalWebsiteUrl("https://example.com/a?q=1#heading")).toBe(
      "https://example.com/a?q=1",
    );
    expect(canonicalWebsiteUrl("https://example.com/a?q=2")).not.toBe(
      canonicalWebsiteUrl("https://example.com/a?q=1"),
    );
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com:444",
      "https://localhost",
      "https://host.local",
      "https://127.0.0.1",
      "file:///tmp/a",
      "javascript:alert(1)",
    ]) {
      expect(() => canonicalWebsiteUrl(url)).toThrow();
    }
  });
  it("parses inert metadata precedence, entities and image URLs relative to the final document", async () => {
    const metadata = await parseWebsiteMetadata(
      Buffer.from(
        '<html><head><title>Fallback</title><meta name="twitter:title" content="Twitter"><meta property="og:title" content="Chosen &amp; title"><meta name="description" content=" Plain   description "><meta property="og:image" content="../hero.png"></head><body><script>throw 1</script></body></html>',
      ),
      "text/html; charset=utf-8",
      "https://example.com/path/page",
    );
    expect(metadata).toEqual({
      title: "Chosen & title",
      description: "Plain description",
      imageUrl: "https://example.com/hero.png",
    });
  });
  it("deduplicates acquisition, saves local imagery, serves cached metadata offline and never fetches when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-preview-"));
    const database = openCacheDatabase(":memory:");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const client = vi.fn(async (url: URL) => ({
      url,
      status: 200,
      contentType: url.pathname.endsWith(".png") ? "image/png" : "text/html",
      body: url.pathname.endsWith(".png")
        ? png
        : Buffer.from('<title>Example</title><meta property="og:image" content="/image.png">'),
    }));
    const service = new LinkPreviewService(database, root, { enabled: true, client });
    try {
      const [a, b] = await Promise.all([
        service.resolve("https://example.com/page#a"),
        service.resolve("https://example.com/page#b"),
      ]);
      expect(a).toEqual(b);
      expect(a).toMatchObject({
        availability: "ready",
        provenance: "viewer-enrichment",
        title: "Example",
        image: { width: 1, height: 1, mimeType: "image/png" },
      });
      expect(a.image?.url).toMatch(/^\/api\/link-preview-images\/[a-f0-9]{64}\.png$/u);
      expect(client).toHaveBeenCalledTimes(2);
      const offline = new LinkPreviewService(database, root, { enabled: false, client });
      expect(await offline.resolve("https://example.com/page")).toEqual(a);
      expect(await offline.resolve("https://example.com/unfetched")).toMatchObject({
        availability: "disabled",
        image: null,
      });
      expect(client).toHaveBeenCalledTimes(2);
      await offline.close();
    } finally {
      await service.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
