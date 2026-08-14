import { join } from "node:path";

import { createError, defineEventHandler } from "h3";

import { getCachedFaviconFile } from "../../cache/contentStore.ts";
import { useLiveViewerRuntime } from "../../live/requestContext.ts";
import { sendCachedContent } from "../_content.ts";
import { faviconKey } from "../_validation.ts";

export default defineEventHandler(async (event) => {
  const runtime = useLiveViewerRuntime(event);
  const key = await faviconKey(event);
  const origin = runtime.faviconOrigin(key);
  if (origin === null) {
    throw createError({ statusCode: 404, statusMessage: "Favicon not found" });
  }
  await sendCachedContent(
    event,
    getCachedFaviconFile(runtime.database, origin),
    join(runtime.cacheDir, "favicons"),
  );
});
