import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../../server/cache/database.ts";
import {
  assertSafeRemoteUrl,
  canonicalFaviconOrigin,
  resolveFavicon,
  type FaviconHttpClient,
  type FaviconHttpResponse,
} from "../../../server/content/favicons.ts";

const roots: string[] = [];
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-favicon-"));
  roots.push(root);
  return root;
}

function response(
  url: URL,
  options: { status?: number; type?: string; body?: Uint8Array | string },
): FaviconHttpResponse {
  return {
    url,
    status: options.status ?? 200,
    contentType: options.type ?? "image/png",
    body:
      typeof options.body === "string"
        ? Buffer.from(options.body)
        : Buffer.from(options.body ?? pixel),
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("favicon URL security", () => {
  it("canonicalizes HTTP origins and rejects credentials, non-HTTP schemes, and IP literals", () => {
    expect(canonicalFaviconOrigin("https://Example.COM:443/path?q=1")).toBe("https://example.com");
    expect(() => canonicalFaviconOrigin("https://user:secret@example.com")).toThrow("credentials");
    expect(() => canonicalFaviconOrigin("file:///C:/secret")).toThrow("HTTP");
    expect(() => canonicalFaviconOrigin("https://127.0.0.1/icon")).toThrow("IP literal");
    expect(() => canonicalFaviconOrigin("https://[::1]/icon")).toThrow("IP literal");
  });

  it("rejects a hostname when any resolved address is private or link-local", async () => {
    await expect(
      assertSafeRemoteUrl(new URL("https://example.test/icon"), {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow("non-public");
    await expect(
      assertSafeRemoteUrl(new URL("https://example.test/icon"), {
        lookup: async () => [{ address: "fe80::1", family: 6 }],
      }),
    ).rejects.toThrow("non-public");
    await expect(
      assertSafeRemoteUrl(new URL("https://example.test/icon"), {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).resolves.toMatchObject({ address: "93.184.216.34", family: 4 });
  });
});

describe("favicon resolution", () => {
  it("rejects provider placeholders and continues through Google, DuckDuckGo, and Yandex", async () => {
    const root = await temporaryRoot();
    const calls: string[] = [];
    const placeholder = Buffer.concat([pixel, Buffer.from("provider-placeholder")]);
    const yandexIcon = Buffer.concat([pixel, Buffer.from("yandex-real-icon")]);
    const client: FaviconHttpClient = async (url) => {
      calls.push(url.href);
      if (url.hostname === "favicon.yandex.net") {
        return response(url, {
          body: url.pathname.includes(".invalid") ? placeholder : yandexIcon,
        });
      }
      return response(url, { body: placeholder });
    };
    const database = openCacheDatabase(":memory:");
    const expectedHash = createHash("sha256").update(yandexIcon).digest("hex");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${expectedHash}.png`), "corrupt viewer cache entry");

    try {
      const result = await resolveFavicon(database, "https://example.com/docs", {
        mode: "export",
        faviconRoot: root,
        client,
      });

      expect(result).toMatchObject({
        status: "available",
        source: "yandex",
        mimeType: "image/png",
      });
      expect(calls.some((url) => url.startsWith("https://www.google.com/s2/favicons"))).toBe(true);
      expect(calls.some((url) => url.startsWith("https://icons.duckduckgo.com/ip3/"))).toBe(true);
      expect(calls.some((url) => url.startsWith("https://favicon.yandex.net/favicon/"))).toBe(true);
      expect(calls.filter((url) => url.includes(".invalid"))).toHaveLength(3);
      expect(await readdir(root)).toEqual([`${result.sha256}.png`]);
      expect(await readFile(result.cachePath!)).toEqual(yandexIcon);
    } finally {
      database.close();
    }
  });

  it("falls through provider failures to declared live icons and then root favicon", async () => {
    const root = await temporaryRoot();
    const liveIcon = Buffer.concat([pixel, Buffer.from("live-icon")]);
    const calls: string[] = [];
    const client: FaviconHttpClient = async (url) => {
      calls.push(url.href);
      if (url.href === "https://example.com/") {
        return response(url, {
          type: "text/html; charset=utf-8",
          body: '<html><head><link rel="icon" href="/bad.txt"><link rel="apple-touch-icon" sizes="180x180" href="/brand.png"></head></html>',
        });
      }
      if (url.href === "https://example.com/bad.txt") {
        return response(url, { type: "text/plain", body: "not an image" });
      }
      if (url.href === "https://example.com/brand.png") {
        return response(url, { body: liveIcon });
      }
      return response(url, { status: 404, body: "missing" });
    };
    const database = openCacheDatabase(":memory:");

    try {
      const result = await resolveFavicon(database, "https://example.com/path", {
        mode: "export",
        faviconRoot: root,
        client,
      });

      expect(result).toMatchObject({
        status: "available",
        source: "origin",
        sourceUrl: "https://example.com/brand.png",
      });
      expect(calls).toContain("https://example.com/");
      expect(calls).toContain("https://example.com/bad.txt");
      expect(calls).toContain("https://example.com/brand.png");
      expect(calls).not.toContain("https://example.com/favicon.ico");
    } finally {
      database.close();
    }
  });

  it("returns a deterministic local tile immediately in live mode and deduplicates background refresh", async () => {
    const root = await temporaryRoot();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = vi.fn<FaviconHttpClient>(async (url) => {
      await blocked;
      return url.href === "https://example.com/favicon.ico"
        ? response(url, { body: Buffer.concat([pixel, Buffer.from("root-icon")]) })
        : response(url, { status: 404, body: "missing" });
    });
    const database = openCacheDatabase(":memory:");

    try {
      const first = await resolveFavicon(database, "https://example.com/a", {
        mode: "live",
        faviconRoot: root,
        client,
      });
      const second = await resolveFavicon(database, "https://example.com/b", {
        mode: "live",
        faviconRoot: root,
        client,
      });
      expect(first).toMatchObject({ status: "fallback", pending: true, fallback: { label: "E" } });
      expect(second.backgroundRefresh).toBe(first.backgroundRefresh);
      release();
      await expect(first.backgroundRefresh).resolves.toMatchObject({
        status: "available",
        source: "origin",
      });
      const cached = await resolveFavicon(database, "https://example.com/c", {
        mode: "live",
        faviconRoot: root,
        client,
      });
      expect(cached).toMatchObject({ status: "available", pending: false });
    } finally {
      database.close();
    }
  });

  it("performs no requests offline and caches failures until expiry", async () => {
    const root = await temporaryRoot();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    const client = vi.fn<FaviconHttpClient>(async (url) =>
      response(url, { status: 404, body: "missing" }),
    );
    const database = openCacheDatabase(":memory:");

    try {
      const offline = await resolveFavicon(database, "https://offline.example", {
        mode: "export",
        offline: true,
        faviconRoot: root,
        client,
      });
      expect(offline).toMatchObject({ status: "fallback", pending: false });
      expect(client).not.toHaveBeenCalled();

      await resolveFavicon(database, "https://missing.example", {
        mode: "export",
        faviconRoot: root,
        client,
        failureTtlMs: 60_000,
      });
      const afterFirst = client.mock.calls.length;
      await resolveFavicon(database, "https://missing.example/path", {
        mode: "export",
        faviconRoot: root,
        client,
        failureTtlMs: 60_000,
      });
      expect(client).toHaveBeenCalledTimes(afterFirst);
      vi.advanceTimersByTime(60_001);
      await resolveFavicon(database, "https://missing.example/again", {
        mode: "export",
        faviconRoot: root,
        client,
        failureTtlMs: 60_000,
      });
      expect(client.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      database.close();
    }
  });
});
