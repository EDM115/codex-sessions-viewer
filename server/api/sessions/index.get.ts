import { defineEventHandler } from "h3";

import { useCatalogReadyLiveViewerRuntime } from "../../live/requestContext.ts";
import { sessionListQuery } from "../_validation.ts";

export default defineEventHandler(async (event) => {
  const query = await sessionListQuery(event);
  return (await useCatalogReadyLiveViewerRuntime(event)).repository.listSessions(query);
});
