import { deepSearchId, notFound } from "#server/api/_validation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const id = await deepSearchId(event);
  try {
    return await useLiveViewerRuntime(event).repository.getDeepSearch(id);
  } catch {
    return notFound("Deep-search job not found");
  }
});
