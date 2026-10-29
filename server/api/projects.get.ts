import { useCatalogReadyLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  return (await useCatalogReadyLiveViewerRuntime(event)).repository.listProjects();
});
