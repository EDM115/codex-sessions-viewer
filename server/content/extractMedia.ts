import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { fileTypeFromBuffer } from "file-type";

import {
  MAX_MEDIA_BYTES,
  type MediaActivity,
  type MediaReference,
} from "../../shared/types/conversation.ts";
import type { EmbeddedMediaSource } from "../../shared/types/richText.ts";
import { upsertCachedAsset } from "../cache/assetStore.ts";
import type { ReferencedMediaSource } from "../ingestion/discoverSources.ts";
import { readStableBytes } from "../ingestion/stableRead.ts";
import { sanitizeSvg } from "./sanitizeSvg.ts";

const MAX_MEDIA_ERROR_LENGTH = 512;
const MAX_ORIGINAL_REFERENCE_LENGTH = 4_096;

export interface MediaStoreOptions {
  assetRoot: string;
  sessionId: string | null;
  trustedMediaRoots?: readonly string[] | undefined;
  readSource?: typeof readStableBytes | undefined;
}

export interface StoredMediaResult {
  assetId: string;
  status: "available" | "missing" | "error";
  cachePath: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
}

interface PreparedMedia {
  bytes: Buffer;
  mimeType: string;
  extension: string;
}

interface TrustedMediaRoot {
  configuredPath: string;
  canonicalPath: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_MEDIA_ERROR_LENGTH);
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
  if (detected === undefined) {
    throw new Error("Referenced media has an unknown file type.");
  }
  if (declaredMimeType !== undefined && detected.mime !== declaredMimeType) {
    throw new Error("Referenced media does not match its declared MIME type.");
  }
  return {
    bytes,
    mimeType: detected.mime,
    extension: detected.ext,
  };
}

function compatibleMediaType(mediaType: MediaActivity["mediaType"], mimeType: string): boolean {
  return mediaType === "file" || mimeType.startsWith(`${mediaType}/`);
}

function assertCompatibleMediaType(
  mediaType: MediaActivity["mediaType"],
  media: PreparedMedia,
): void {
  if (!compatibleMediaType(mediaType, media.mimeType)) {
    throw new Error("Referenced media does not match its declared media type.");
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function sameResolvedPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

async function resolveTrustedMediaRoots(paths: readonly string[]): Promise<TrustedMediaRoot[]> {
  const roots: TrustedMediaRoot[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- Roots are user-approved and validated independently.
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Canonical roots are required before candidate containment checks.
      roots.push({ configuredPath: resolve(path), canonicalPath: await realpath(path) });
    } catch {
      // A missing optional attachment root simply authorizes no files beneath it.
    }
  }
  return roots;
}

function percentDecodedSize(payload: string): number {
  let size = 0;
  for (let index = 0; index < payload.length;) {
    if (payload[index] === "%") {
      const encoded = payload.slice(index + 1, index + 3);
      if (!/^[\da-f]{2}$/iu.test(encoded)) {
        throw new Error("Embedded media contains malformed percent encoding.");
      }
      size += 1;
      index += 3;
    } else {
      const codePoint = payload.codePointAt(index);
      if (codePoint === undefined) {
        throw new Error("Embedded media contains malformed text.");
      }
      const character = String.fromCodePoint(codePoint);
      size += Buffer.byteLength(character);
      index += character.length;
    }
    if (size > MAX_MEDIA_BYTES) {
      throw new Error("Embedded media exceeds the 64 MiB limit.");
    }
  }
  return size;
}

function decodeDataReference(reference: Extract<MediaReference, { kind: "data" }>): Buffer {
  if (reference.encoding === "base64") {
    if (reference.payload.length % 4 !== 0 || !/^[a-z\d+/]*={0,2}$/iu.test(reference.payload)) {
      throw new Error("Embedded media contains malformed base64 encoding.");
    }
    const padding = reference.payload.endsWith("==") ? 2 : reference.payload.endsWith("=") ? 1 : 0;
    const expectedSize = (reference.payload.length / 4) * 3 - padding;
    if (expectedSize > MAX_MEDIA_BYTES) {
      throw new Error("Embedded media exceeds the 64 MiB limit.");
    }
    const bytes = Buffer.from(reference.payload, "base64");
    if (bytes.byteLength !== expectedSize) {
      throw new Error("Embedded media contains malformed base64 encoding.");
    }
    return bytes;
  }

  const size = percentDecodedSize(reference.payload);
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  for (let index = 0; index < reference.payload.length;) {
    if (reference.payload[index] === "%") {
      bytes[offset] = Number.parseInt(reference.payload.slice(index + 1, index + 3), 16);
      offset += 1;
      index += 3;
    } else {
      const codePoint = reference.payload.codePointAt(index)!;
      const character = String.fromCodePoint(codePoint);
      offset += Buffer.from(character).copy(bytes, offset);
      index += character.length;
    }
  }
  return bytes;
}

function boundedOriginalReference(reference: MediaReference): string | null {
  let value: string | null;
  if (reference.kind === "local-file") {
    value = reference.path;
  } else if (reference.kind === "remote") {
    value = reference.url;
  } else if (reference.kind === "data") {
    value = `data:${reference.mimeType};${reference.encoding};sha256=${reference.sourceHash}`;
  } else if (reference.kind === "invalid") {
    value = reference.preview;
  } else {
    value = null;
  }
  return value?.slice(0, MAX_ORIGINAL_REFERENCE_LENGTH) ?? null;
}

async function prepareLocalMedia(
  reference: Extract<MediaReference, { kind: "local-file" }>,
  mediaType: MediaActivity["mediaType"],
  trustedRoots: readonly TrustedMediaRoot[],
  readSource: typeof readStableBytes,
): Promise<PreparedMedia> {
  const candidate = resolve(reference.path);
  const trustedRoot = trustedRoots.find((root) => isWithinRoot(root.configuredPath, candidate));
  if (trustedRoot === undefined) {
    throw new Error("Referenced media is outside the configured trusted media roots.");
  }
  const metadata = await lstat(candidate);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink > 1 ||
    metadata.size > MAX_MEDIA_BYTES
  ) {
    throw new Error("Referenced media is not an unlinked regular file within the 64 MiB limit.");
  }
  const canonical = await realpath(candidate);
  const expectedCanonical = resolve(
    trustedRoot.canonicalPath,
    relative(trustedRoot.configuredPath, candidate),
  );
  if (
    !sameResolvedPath(canonical, expectedCanonical) ||
    !isWithinRoot(trustedRoot.canonicalPath, canonical)
  ) {
    throw new Error("Referenced media resolves outside the configured trusted media roots.");
  }
  const read = await readSource(candidate, { endExclusive: metadata.size });
  if (read.read.status !== "stable") {
    throw new Error("Referenced media changed while it was being copied.");
  }
  const media = await preparedMedia(read.bytes);
  assertCompatibleMediaType(mediaType, media);
  return media;
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
  return {
    assetId: input.assetId,
    status: input.status,
    cachePath: input.cachePath,
    mimeType: input.media?.mimeType ?? null,
    byteSize: input.media?.bytes.byteLength ?? null,
    sha256: input.sha256,
  };
}

export async function storeReferencedMedia(
  database: DatabaseSync,
  references: readonly ReferencedMediaSource[],
  options: MediaStoreOptions,
): Promise<StoredMediaResult[]> {
  const results: StoredMediaResult[] = [];
  const trustedRoots = await resolveTrustedMediaRoots(options.trustedMediaRoots ?? []);
  for (const reference of references) {
    try {
      if (reference.reference.kind === "remote") {
        throw new Error("Remote media is not fetched by the offline viewer.");
      }
      if (reference.reference.kind === "invalid") {
        throw new Error(`Invalid media reference: ${reference.reference.reason}.`);
      }
      const media =
        reference.reference.kind === "data"
          ? // oxlint-disable-next-line no-await-in-loop -- Data decoding and MIME validation are bounded before storage.
            await preparedMedia(
              decodeDataReference(reference.reference),
              reference.reference.mimeType,
            )
          : // oxlint-disable-next-line no-await-in-loop -- Each approved local source is copied and verified before exposure.
            await prepareLocalMedia(
              reference.reference,
              reference.mediaType,
              trustedRoots,
              options.readSource ?? readStableBytes,
            );
      assertCompatibleMediaType(reference.mediaType, media);
      // oxlint-disable-next-line no-await-in-loop -- Content-addressed writes are intentionally ordered with cache metadata writes.
      const stored = await writeContentAddressed(options.assetRoot, media);
      results.push(
        writeAssetRecord(database, {
          assetId: reference.assetId,
          originalPath: boundedOriginalReference(reference.reference),
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
          originalPath: boundedOriginalReference(reference.reference),
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
