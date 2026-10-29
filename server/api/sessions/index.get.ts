import { sessionListQuery } from "#server/api/_validation.ts";
import { useCatalogReadyLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const query = await sessionListQuery(event);
  return (await useCatalogReadyLiveViewerRuntime(event)).repository.listSessions(query);
});
