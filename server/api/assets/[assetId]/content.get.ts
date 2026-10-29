import { join } from "node:path";

import { sendCachedContent } from "#server/api/_content.ts";
import { assetId } from "#server/api/_validation.ts";
import { getCachedAssetFile } from "#server/cache/contentStore.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const runtime = useLiveViewerRuntime(event);
  const id = await assetId(event);
  return sendCachedContent(
    event,
    getCachedAssetFile(runtime.database, id),
    join(runtime.cacheDir, "assets"),
  );
});
