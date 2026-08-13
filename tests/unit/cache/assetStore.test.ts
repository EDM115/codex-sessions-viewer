import { describe, expect, it } from "vitest";

import { getCachedAsset, upsertCachedAsset } from "../../../server/cache/assetStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { resolvedAssetSchema } from "../../../shared/types/repository.ts";

describe("cached asset metadata", () => {
  it("upserts asset state and returns only the resolver contract", () => {
    const database = openCacheDatabase(":memory:");

    try {
      upsertCachedAsset(database, {
        id: "asset-1",
        sessionId: null,
        url: null,
        mimeType: null,
        byteSize: null,
        sha256: null,
        width: null,
        height: null,
        status: "missing",
        originalPath: "C:\\work\\missing.png",
        cachePath: null,
        error: "not found",
      });
      upsertCachedAsset(database, {
        id: "asset-1",
        sessionId: null,
        url: "/assets/asset-1.png",
        mimeType: "image/png",
        byteSize: 128,
        sha256: "c".repeat(64),
        width: 16,
        height: 8,
        status: "available",
        originalPath: "C:\\work\\missing.png",
        cachePath: "C:\\viewer\\assets\\asset-1.png",
        error: null,
      });

      const resolved = getCachedAsset(database, "asset-1");
      expect(resolvedAssetSchema.parse(resolved)).toEqual({
        id: "asset-1",
        url: "/assets/asset-1.png",
        mimeType: "image/png",
        byteSize: 128,
        sha256: "c".repeat(64),
        width: 16,
        height: 8,
        status: "available",
        originalPath: "C:\\work\\missing.png",
      });
      expect(JSON.stringify(resolved)).not.toContain("cachePath");
      expect(getCachedAsset(database, "unknown")).toBeNull();
    } finally {
      database.close();
    }
  });
});
