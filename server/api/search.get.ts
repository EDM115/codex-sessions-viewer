import { searchQuery } from "#server/api/_validation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const query = await searchQuery(event);
  return useLiveViewerRuntime(event).repository.search(query);
});
