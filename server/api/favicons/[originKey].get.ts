import { join } from "node:path";

import { sendCachedContent } from "#server/api/_content.ts";
import { faviconKey } from "#server/api/_validation.ts";
import { getCachedFaviconFile } from "#server/cache/contentStore.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const runtime = useLiveViewerRuntime(event);
  const key = await faviconKey(event);
  const origin = runtime.faviconOrigin(key);
  if (origin === null) {
    throw createError({ statusCode: 404, statusMessage: "Favicon not found" });
  }
  return sendCachedContent(
    event,
    getCachedFaviconFile(runtime.database, origin),
    join(runtime.cacheDir, "favicons"),
  );
});
