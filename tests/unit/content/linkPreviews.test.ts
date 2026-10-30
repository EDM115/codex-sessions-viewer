import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import { createFaviconHttpClient } from "#server/content/favicons.ts";
import { LinkPreviewService, parseWebsiteMetadata } from "#server/content/linkPreviews.ts";
import { previewImageDimensions } from "#server/content/previewImage.ts";
import { canonicalWebsiteUrl } from "#shared/types/linkPreview.ts";

describe("website preview enrichment", () => {
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
