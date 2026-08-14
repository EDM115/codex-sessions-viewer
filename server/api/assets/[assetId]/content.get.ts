import { join } from "node:path";

import { defineEventHandler } from "h3";

import { getCachedAssetFile } from "../../../cache/contentStore.ts";
import { useLiveViewerRuntime } from "../../../live/requestContext.ts";
import { sendCachedContent } from "../../_content.ts";
import { assetId } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const runtime = useLiveViewerRuntime(event);
  const id = await assetId(event);
  await sendCachedContent(
    event,
    getCachedAssetFile(runtime.database, id),
    join(runtime.cacheDir, "assets"),
  );
});
