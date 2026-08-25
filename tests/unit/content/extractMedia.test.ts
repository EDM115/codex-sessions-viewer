import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getCachedAsset } from "../../../server/cache/assetStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { storeEmbeddedMedia, storeReferencedMedia } from "../../../server/content/extractMedia.ts";
import type { ReferencedMediaSource } from "../../../server/ingestion/discoverSources.ts";
import { MAX_MEDIA_BYTES } from "../../../shared/types/conversation.ts";

const roots: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function localReference(
  assetId: string,
  mediaType: ReferencedMediaSource["mediaType"],
  path: string,
): ReferencedMediaSource {
  return {
    assetId,
    mediaType,
    reference: { kind: "local-file", path, provenance: "user-message" },
  };
}

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
          localReference("asset-diagram", "image", referenced),
          localReference("asset-missing", "image", join(sourceRoot, "missing.png")),
        ],
        { assetRoot: cacheRoot, sessionId: null, trustedMediaRoots: [sourceRoot] },
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

  it("decodes bounded data PNG and SVG references without retaining their payloads", async () => {
    const root = await temporaryRoot();
    const cacheRoot = join(root, "private-assets");
    const database = openCacheDatabase(":memory:");
    const svgPayload =
      "%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20onload%3D%22alert(1)%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3Crect%20width%3D%221%22%20height%3D%221%22%2F%3E%3C%2Fsvg%3E";

    try {
      const stored = await storeReferencedMedia(
        database,
        [
          {
            assetId: "asset-data-png",
            mediaType: "image",
            reference: {
              kind: "data",
              mimeType: "image/png",
              encoding: "base64",
              payload: png.toString("base64"),
              sourceHash: "a".repeat(64),
            },
          },
          {
            assetId: "asset-data-svg",
            mediaType: "image",
            reference: {
              kind: "data",
              mimeType: "image/svg+xml",
              encoding: "percent",
              payload: svgPayload,
              sourceHash: "b".repeat(64),
            },
          },
        ],
        { assetRoot: cacheRoot, sessionId: null },
      );

      expect(stored.map(({ status }) => status)).toEqual(["available", "available"]);
      expect(getCachedAsset(database, "asset-data-png")).toMatchObject({
        mimeType: "image/png",
        originalPath: `data:image/png;base64;sha256=${"a".repeat(64)}`,
      });
      expect(JSON.stringify(getCachedAsset(database, "asset-data-png"))).not.toContain(
        png.toString("base64"),
      );
      const svg = getCachedAsset(database, "asset-data-svg");
      expect(svg).toMatchObject({ mimeType: "image/svg+xml", status: "available" });
      const storedSvg = stored.at(1);
      if (storedSvg?.cachePath === null || storedSvg?.cachePath === undefined) {
        throw new Error("Expected the embedded SVG to be available.");
      }
      const sanitized = await readFile(storedSvg.cachePath, "utf8");
      expect(sanitized).toContain("<rect");
      expect(sanitized).not.toMatch(/script|onload/iu);
    } finally {
      database.close();
    }
  });

  it("rejects remote, malformed, and MIME-mismatched data references with bounded records", async () => {
    const root = await temporaryRoot();
    const database = openCacheDatabase(":memory:");
    const references: ReferencedMediaSource[] = [
      {
        assetId: "asset-remote",
        mediaType: "image",
        reference: { kind: "remote", url: "https://example.test/image.png" },
      },
      {
        assetId: "asset-invalid",
        mediaType: "image",
        reference: {
          kind: "invalid",
          reason: "malformed-data",
          preview: "x".repeat(160),
          sourceHash: "c".repeat(64),
        },
      },
      {
        assetId: "asset-mismatch",
        mediaType: "image",
        reference: {
          kind: "data",
          mimeType: "image/jpeg",
          encoding: "base64",
          payload: png.toString("base64"),
          sourceHash: "d".repeat(64),
        },
      },
      {
        assetId: "asset-malformed",
        mediaType: "image",
        reference: {
          kind: "data",
          mimeType: "image/png",
          encoding: "base64",
          payload: "%%%",
          sourceHash: "e".repeat(64),
        },
      },
      {
        assetId: "asset-oversized",
        mediaType: "image",
        reference: {
          kind: "invalid",
          reason: "oversized-data",
          preview: "data:image/png;base64",
          sourceHash: "f".repeat(64),
        },
      },
    ];

    try {
      await expect(
        storeReferencedMedia(database, references, {
          assetRoot: join(root, "private-assets"),
          sessionId: null,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ assetId: "asset-remote", status: "error" }),
        expect.objectContaining({ assetId: "asset-invalid", status: "error" }),
        expect.objectContaining({ assetId: "asset-mismatch", status: "error" }),
        expect.objectContaining({ assetId: "asset-malformed", status: "error" }),
        expect.objectContaining({ assetId: "asset-oversized", status: "error" }),
      ]);
      for (const { assetId } of references) {
        const asset = database
          .prepare("SELECT cache_path, error, original_path FROM assets WHERE id = ?")
          .get(assetId);
        expect(asset?.["cache_path"]).toBeNull();
        expect(String(asset?.["error"]).length).toBeLessThanOrEqual(512);
        expect(String(asset?.["original_path"] ?? "").length).toBeLessThanOrEqual(4_096);
        expect(JSON.stringify(asset)).not.toContain(png.toString("base64"));
      }
    } finally {
      database.close();
    }
  });

  it("enforces trusted roots, regular-file identity, link safety, size, and media type", async () => {
    const root = await temporaryRoot();
    const trustedRoot = join(root, "attachments");
    const outsideRoot = join(root, "outside");
    const cacheRoot = join(root, "private-assets");
    await Promise.all([
      mkdir(trustedRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
    ]);
    const valid = join(trustedRoot, "valid.png");
    const outside = join(outsideRoot, "outside.png");
    const unknown = join(trustedRoot, "unknown.bin");
    const mismatched = join(trustedRoot, "audio.png");
    const hardLinkTarget = join(trustedRoot, "hard-target.png");
    const hardLink = join(trustedRoot, "hard-link.png");
    const symbolicLink = join(trustedRoot, "symbolic-link.png");
    const oversized = join(trustedRoot, "oversized.png");
    await Promise.all([
      writeFile(valid, png),
      writeFile(outside, png),
      writeFile(unknown, "not media"),
      writeFile(mismatched, png),
      writeFile(hardLinkTarget, png),
      writeFile(oversized, png),
    ]);
    await link(hardLinkTarget, hardLink);
    await symlink(valid, symbolicLink, "file");
    await truncate(oversized, MAX_MEDIA_BYTES + 1);
    const references = [
      localReference("asset-valid", "image", valid),
      localReference("asset-outside", "image", outside),
      localReference("asset-missing", "image", join(trustedRoot, "missing.png")),
      localReference("asset-directory", "image", trustedRoot),
      localReference("asset-symlink", "image", symbolicLink),
      localReference("asset-hardlink", "image", hardLink),
      localReference("asset-unknown", "file", unknown),
      localReference("asset-oversized", "image", oversized),
      localReference("asset-mismatch", "audio", mismatched),
    ];
    const database = openCacheDatabase(":memory:");

    try {
      const stored = await storeReferencedMedia(database, references, {
        assetRoot: cacheRoot,
        sessionId: null,
        trustedMediaRoots: [trustedRoot],
      });

      expect(stored.map(({ status }) => status)).toEqual([
        "available",
        "error",
        "missing",
        "error",
        "error",
        "error",
        "error",
        "error",
        "error",
      ]);
      expect(await readFile(valid)).toEqual(png);
      expect(await readdir(cacheRoot)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("does not publish bytes when a trusted local source changes during its stable read", async () => {
    const root = await temporaryRoot();
    const trustedRoot = join(root, "attachments");
    const source = join(trustedRoot, "changing.png");
    await mkdir(trustedRoot, { recursive: true });
    await writeFile(source, png);
    const readSource = vi
      .fn<typeof import("../../../server/ingestion/stableRead.ts").readStableBytes>()
      .mockResolvedValue({
        read: { status: "changed", retry: true, bytesRead: 0 },
        bytes: Buffer.alloc(0),
      });
    const database = openCacheDatabase(":memory:");

    try {
      const stored = await storeReferencedMedia(
        database,
        [localReference("asset-changing", "image", source)],
        {
          assetRoot: join(root, "private-assets"),
          sessionId: null,
          trustedMediaRoots: [trustedRoot],
          readSource,
        },
      );
      expect(stored).toEqual([
        expect.objectContaining({ assetId: "asset-changing", status: "error" }),
      ]);
      expect(readSource).toHaveBeenCalledOnce();
      expect(stored[0]?.cachePath).toBeNull();
    } finally {
      database.close();
    }
  });
});
