import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { fileTypeFromBuffer } from "file-type";

import type { EmbeddedMediaSource } from "../../shared/types/richText.ts";
import { upsertCachedAsset } from "../cache/assetStore.ts";
import type { ReferencedLocalMediaSource } from "../ingestion/discoverSources.ts";
import { readStableBytes } from "../ingestion/stableRead.ts";
import { sanitizeSvg } from "./sanitizeSvg.ts";

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

export interface MediaStoreOptions {
  assetRoot: string;
  sessionId: string | null;
}

export interface StoredMediaResult {
  assetId: string;
  status: "available" | "missing" | "error";
  cachePath: string | null;
}

interface PreparedMedia {
  bytes: Buffer;
  mimeType: string | null;
  extension: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertAssetRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const root = await lstat(path);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("The private media cache root must be an unlinked directory.");
  }
}

async function verifyExisting(path: string, expectedHash: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
      return false;
    }
    return sha256(await readFile(path)) === expectedHash;
  } catch {
    return false;
  }
}

async function writeContentAddressed(
  assetRoot: string,
  media: PreparedMedia,
): Promise<{ cachePath: string; sha256: string }> {
  await assertAssetRoot(assetRoot);
  const hash = sha256(media.bytes);
  const destination = join(assetRoot, `${hash}.${media.extension}`);
  if (await verifyExisting(destination, hash)) {
    return { cachePath: destination, sha256: hash };
  }
  const temporary = join(assetRoot, `.${hash}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, media.bytes, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!(await verifyExisting(destination, hash))) {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  if (!(await verifyExisting(destination, hash))) {
    throw new Error("The content-addressed media file failed its integrity check.");
  }
  return { cachePath: destination, sha256: hash };
}

async function preparedMedia(bytes: Buffer, declaredMimeType?: string): Promise<PreparedMedia> {
  const text = bytes.subarray(0, 512).toString("utf8").trimStart();
  if (declaredMimeType === "image/svg+xml" || /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(text)) {
    const sanitized = await sanitizeSvg(bytes.toString("utf8"));
    if (sanitized === null) {
      throw new Error("The SVG media could not be sanitized.");
    }
    return { bytes: Buffer.from(sanitized), mimeType: "image/svg+xml", extension: "svg" };
  }
  const detected = await fileTypeFromBuffer(bytes);
  return {
    bytes,
    mimeType: detected?.mime ?? declaredMimeType ?? null,
    extension: detected?.ext ?? "bin",
  };
}

function writeAssetRecord(
  database: DatabaseSync,
  input: {
    assetId: string;
    originalPath: string | null;
    status: "available" | "missing" | "error";
    media: PreparedMedia | null;
    cachePath: string | null;
    sha256: string | null;
    sessionId: string | null;
    error: string | null;
  },
): StoredMediaResult {
  upsertCachedAsset(database, {
    id: input.assetId,
    sessionId: input.sessionId,
    url: null,
    mimeType: input.media?.mimeType ?? null,
    byteSize: input.media?.bytes.byteLength ?? null,
    sha256: input.sha256,
    width: null,
    height: null,
    status: input.status,
    originalPath: input.originalPath,
    cachePath: input.cachePath,
    error: input.error,
  });
  return { assetId: input.assetId, status: input.status, cachePath: input.cachePath };
}

export async function storeReferencedMedia(
  database: DatabaseSync,
  references: readonly ReferencedLocalMediaSource[],
  options: MediaStoreOptions,
): Promise<StoredMediaResult[]> {
  const results: StoredMediaResult[] = [];
  for (const reference of references) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each source is copied and integrity-checked before its cache row is exposed.
      const metadata = await stat(reference.path);
      if (!metadata.isFile() || metadata.size > MAX_MEDIA_BYTES) {
        throw new Error("Referenced media is not a regular file within the 64 MiB limit.");
      }
      // oxlint-disable-next-line no-await-in-loop -- Stable reads must complete before the corresponding cache row is written.
      const read = await readStableBytes(reference.path, { endExclusive: metadata.size });
      if (read.read.status !== "stable") {
        throw new Error("Referenced media changed while it was being copied.");
      }
      // oxlint-disable-next-line no-await-in-loop -- MIME sniffing and SVG sanitization are bounded by MAX_MEDIA_BYTES.
      const media = await preparedMedia(read.bytes);
      // oxlint-disable-next-line no-await-in-loop -- Content-addressed writes are intentionally ordered with cache metadata writes.
      const stored = await writeContentAddressed(options.assetRoot, media);
      results.push(
        writeAssetRecord(database, {
          assetId: reference.assetId,
          originalPath: reference.path,
          status: "available",
          media,
          cachePath: stored.cachePath,
          sha256: stored.sha256,
          sessionId: options.sessionId,
          error: null,
        }),
      );
    } catch (error) {
      results.push(
        writeAssetRecord(database, {
          assetId: reference.assetId,
          originalPath: reference.path,
          status: isMissing(error) ? "missing" : "error",
          media: null,
          cachePath: null,
          sha256: null,
          sessionId: options.sessionId,
          error: errorMessage(error),
        }),
      );
    }
  }
  return results;
}

export async function storeEmbeddedMedia(
  database: DatabaseSync,
  sources: readonly EmbeddedMediaSource[],
  options: MediaStoreOptions,
): Promise<StoredMediaResult[]> {
  const results: StoredMediaResult[] = [];
  for (const source of sources) {
    try {
      if (source.byteSize !== source.bytes.byteLength || source.byteSize > MAX_MEDIA_BYTES) {
        throw new Error("Embedded media has an invalid or oversized byte count.");
      }
      // oxlint-disable-next-line no-await-in-loop -- Embedded media is bounded and sanitized before storage.
      const media = await preparedMedia(Buffer.from(source.bytes), source.mimeType);
      // oxlint-disable-next-line no-await-in-loop -- Content-addressed writes are intentionally ordered with cache metadata writes.
      const stored = await writeContentAddressed(options.assetRoot, media);
      results.push(
        writeAssetRecord(database, {
          assetId: source.assetId,
          originalPath: null,
          status: "available",
          media,
          cachePath: stored.cachePath,
          sha256: stored.sha256,
          sessionId: options.sessionId,
          error: null,
        }),
      );
    } catch (error) {
      results.push(
        writeAssetRecord(database, {
          assetId: source.assetId,
          originalPath: null,
          status: "error",
          media: null,
          cachePath: null,
          sha256: null,
          sessionId: options.sessionId,
          error: errorMessage(error),
        }),
      );
    }
  }
  return results;
}
