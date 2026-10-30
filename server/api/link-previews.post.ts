import * as z from "zod";

import { assertSameOriginMutation } from "#server/api/_validation.ts";
import { historyRequestSignal, readBoundedHistoryBody } from "#server/live/requestCancellation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";
import { canonicalWebsiteUrl } from "#shared/types/linkPreview.ts";

export default defineEventHandler(async (event) => {
  assertSameOriginMutation(event);
  const signal = historyRequestSignal(event);
  const input = z
    .strictObject({ url: z.string().max(4096) })
    .safeParse(await readBoundedHistoryBody(event, 8192));
  if (!input.success) {
    throw createError({ statusCode: 400, statusMessage: "Invalid preview request" });
  }
  let url: string;
  try {
    url = canonicalWebsiteUrl(input.data.url);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Unsupported preview URL" });
  }
  return useLiveViewerRuntime(event).resolveLinkPreview(url, signal);
});
