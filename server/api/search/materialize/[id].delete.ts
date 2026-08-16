import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../../../live/requestContext.ts";
import { assertSameOriginMutation, deepSearchId, notFound } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  assertSameOriginMutation(event);
  const id = await deepSearchId(event);
  try {
    await useLiveViewerRuntime(event).repository.cancelDeepSearch(id);
    return { cancelled: true };
  } catch {
    return notFound("Deep-search job not found");
  }
});
