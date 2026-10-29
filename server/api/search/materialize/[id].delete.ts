import { assertSameOriginMutation, deepSearchId, notFound } from "#server/api/_validation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

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
