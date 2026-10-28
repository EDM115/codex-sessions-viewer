import { defineEventHandler } from "h3";

import { useCatalogReadyLiveViewerRuntime } from "../live/requestContext.ts";

export default defineEventHandler(async (event) => {
  return (await useCatalogReadyLiveViewerRuntime(event)).repository.listProjects();
});
