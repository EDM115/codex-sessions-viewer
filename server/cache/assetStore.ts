import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { resolvedAssetSchema, type ResolvedAsset } from "../../shared/types/repository.ts";

export interface CachedAssetWrite extends ResolvedAsset {
  sessionId: string | null;
  cachePath: string | null;
  error: string | null;
}

function textOrNull(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("The viewer asset cache contains a non-text value.");
  }
  return value;
}

function numberOrNull(value: SQLOutputValue | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number") {
    throw new Error("The viewer asset cache contains a non-numeric value.");
  }
  return value;
}

export function upsertCachedAsset(database: DatabaseSync, asset: CachedAssetWrite): void {
  const resolved = resolvedAssetSchema.parse({
    id: asset.id,
    url: asset.url,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    originalPath: asset.originalPath,
  });
  for (const value of [asset.sessionId, asset.cachePath, asset.error]) {
    if (value !== null && typeof value !== "string") {
      throw new Error("Private viewer asset metadata must be text or null.");
    }
  }
  database
    .prepare(`
      INSERT INTO assets (
        id, session_id, url, mime_type, byte_size, sha256, width, height, status,
        original_path, cache_path, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        url = excluded.url,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        sha256 = excluded.sha256,
        width = excluded.width,
        height = excluded.height,
        status = excluded.status,
        original_path = excluded.original_path,
        cache_path = excluded.cache_path,
        error = excluded.error
    `)
    .run(
      resolved.id,
      asset.sessionId,
      resolved.url,
      resolved.mimeType,
      resolved.byteSize,
      resolved.sha256,
      resolved.width,
      resolved.height,
      resolved.status,
      resolved.originalPath,
      asset.cachePath,
      asset.error,
    );
}

export function getCachedAsset(database: DatabaseSync, assetId: string): ResolvedAsset | null {
  const row = database
    .prepare(`
      SELECT id, url, mime_type, byte_size, sha256, width, height, status, original_path
      FROM assets
      WHERE id = ?
    `)
    .get(assetId);
  if (row === undefined) {
    return null;
  }
  return resolvedAssetSchema.parse({
    id: textOrNull(row["id"]),
    url: textOrNull(row["url"]),
    mimeType: textOrNull(row["mime_type"]),
    byteSize: numberOrNull(row["byte_size"]),
    sha256: textOrNull(row["sha256"]),
    width: numberOrNull(row["width"]),
    height: numberOrNull(row["height"]),
    status: textOrNull(row["status"]),
    originalPath: textOrNull(row["original_path"]),
  });
}
