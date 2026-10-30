import { join } from "node:path";

import { assertSameOriginMutation } from "#server/api/_validation.ts";
import { storeEmbeddedMedia } from "#server/content/extractMedia.ts";
import { prepareHistoryAttachments } from "#server/content/historyAttachments.ts";
import { resolvedTrustedMediaRoots } from "#server/core/config.ts";
import { prepareHistoryPresentation } from "#server/history/historyPresentation.ts";
import { historyRequestSignal, readBoundedHistoryBody } from "#server/live/requestCancellation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";
import { historyPresentationRequestSchema } from "#shared/types/history.ts";

export default defineEventHandler(async (event) => {
  assertSameOriginMutation(event);
  const signal = historyRequestSignal(event);
  try {
    const query = historyPresentationRequestSchema.parse(
      await readBoundedHistoryBody(event, 6 * 1024 * 1024),
    );
    const runtime = useLiveViewerRuntime(event);
    const database = runtime.database;
    return prepareHistoryPresentation(query, signal, {
      onDocument: (document) => runtime.scheduleDocumentFavicons(document),
      cacheScope: JSON.stringify([
        runtime.cacheDir,
        runtime.settings.codexHome,
        resolvedTrustedMediaRoots(runtime.settings),
      ]),
      prepareAttachments: (attachments) =>
        prepareHistoryAttachments(database, attachments, {
          assetRoot: join(runtime.cacheDir, "assets"),
          sessionId: null,
          trustedMediaRoots: resolvedTrustedMediaRoots(runtime.settings),
        }),
      storeEmbeddedMedia: async (sources) => {
        await storeEmbeddedMedia(database, sources, {
          assetRoot: join(runtime.cacheDir, "assets"),
          sessionId: null,
        });
      },
    });
  } catch (error) {
    signal.throwIfAborted();
    throw createError({
      statusCode: error instanceof Error && error.message === "history.body_too_large" ? 413 : 400,
      statusMessage: "Invalid presentation request",
    });
  }
});
