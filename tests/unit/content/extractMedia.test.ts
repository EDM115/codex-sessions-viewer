import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getCachedAsset } from "../../../server/cache/assetStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { storeEmbeddedMedia, storeReferencedMedia } from "../../../server/content/extractMedia.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-media-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content-addressed media storage", () => {
  it("copies only referenced media without changing source files", async () => {
    const root = await temporaryRoot();
    const sourceRoot = join(root, "codex");
    const cacheRoot = join(root, "private-assets");
    const referenced = join(sourceRoot, "diagram.png");
    const unreferenced = join(sourceRoot, "secret.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(referenced, png);
    await writeFile(unreferenced, Buffer.from("not referenced"));
    await mkdir(cacheRoot, { recursive: true });
    const expectedHash = createHash("sha256").update(png).digest("hex");
    await writeFile(join(cacheRoot, `${expectedHash}.png`), "corrupt viewer cache entry");
    const before = await stat(referenced);
    const database = openCacheDatabase(":memory:");

    try {
      const stored = await storeReferencedMedia(
        database,
        [
          { assetId: "asset-diagram", mediaType: "image", path: referenced },
          { assetId: "asset-missing", mediaType: "image", path: join(sourceRoot, "missing.png") },
        ],
        { assetRoot: cacheRoot, sessionId: null },
      );

      expect(stored).toEqual([
        expect.objectContaining({ assetId: "asset-diagram", status: "available" }),
        expect.objectContaining({ assetId: "asset-missing", status: "missing" }),
      ]);
      const cached = getCachedAsset(database, "asset-diagram");
      expect(cached).toMatchObject({
        status: "available",
        mimeType: "image/png",
        byteSize: png.byteLength,
        originalPath: referenced,
      });
      expect(await readdir(cacheRoot)).toEqual([`${cached!.sha256}.png`]);
      expect(await readFile(join(cacheRoot, `${cached!.sha256}.png`))).toEqual(png);
      expect(await stat(referenced)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
      expect(await readFile(referenced)).toEqual(png);
      expect((await readdir(cacheRoot)).some((name) => name.includes("secret"))).toBe(false);
      expect(getCachedAsset(database, "asset-missing")).toMatchObject({
        status: "missing",
        originalPath: join(sourceRoot, "missing.png"),
      });
    } finally {
      database.close();
    }
  });

  it("sanitizes SVG and reuses identical embedded content", async () => {
    const root = await temporaryRoot();
    const cacheRoot = join(root, "private-assets");
    const database = openCacheDatabase(":memory:");
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" onload="alert(1)"><script>alert(1)</script><rect width="16" height="16" fill="#123456"/><rect width="8" height="8" stroke="url(https://evil.example/paint)"/><image href="https://evil.example/pixel"/></svg>',
    );

    try {
      const [first, second] = await storeEmbeddedMedia(
        database,
        [
          {
            assetId: "asset-svg-a",
            mediaType: "image",
            mimeType: "image/svg+xml",
            byteSize: svg.byteLength,
            bytes: svg,
          },
          {
            assetId: "asset-svg-b",
            mediaType: "image",
            mimeType: "image/svg+xml",
            byteSize: svg.byteLength,
            bytes: svg,
          },
        ],
        { assetRoot: cacheRoot, sessionId: null },
      );
      const files = await readdir(cacheRoot);

      expect(first).toMatchObject({ status: "available" });
      expect(second).toMatchObject({ status: "available" });
      expect(files).toHaveLength(1);
      const sanitized = await readFile(join(cacheRoot, files[0]!), "utf8");
      expect(sanitized).toContain("<rect");
      expect(sanitized).not.toMatch(/script|onload|image|evil\.example/iu);
    } finally {
      database.close();
    }
  });
});
