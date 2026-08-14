import type { DatabaseSync } from "node:sqlite";

export interface CachedContentFile {
  path: string;
  mimeType: string | null;
  sha256: string;
  byteSize: number | null;
}

function contentRow(row: Record<string, unknown> | undefined): CachedContentFile | null {
  if (
    row === undefined ||
    row["status"] !== "available" ||
    typeof row["cache_path"] !== "string" ||
    typeof row["sha256"] !== "string"
  ) {
    return null;
  }
  return {
    path: row["cache_path"],
    mimeType: typeof row["mime_type"] === "string" ? row["mime_type"] : null,
    sha256: row["sha256"],
    byteSize: typeof row["byte_size"] === "number" ? row["byte_size"] : null,
  };
}

export function getCachedAssetFile(
  database: DatabaseSync,
  assetId: string,
): CachedContentFile | null {
  return contentRow(
    database
      .prepare("SELECT status, cache_path, mime_type, sha256, byte_size FROM assets WHERE id = ?")
      .get(assetId),
  );
}

export function getCachedFaviconFile(
  database: DatabaseSync,
  origin: string,
): CachedContentFile | null {
  return contentRow(
    database
      .prepare(
        "SELECT status, cache_path, mime_type, sha256, byte_size FROM favicons WHERE origin = ?",
      )
      .get(origin),
  );
}
