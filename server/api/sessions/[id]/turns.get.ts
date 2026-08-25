import { defineEventHandler } from "h3";

import { useCatalogReadyLiveViewerRuntime } from "../../../live/requestContext.ts";
import { notFound, sessionId, turnChunkQuery } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const [id, query] = await Promise.all([sessionId(event), turnChunkQuery(event)]);
  try {
    const runtime = await useCatalogReadyLiveViewerRuntime(event);
    return await runtime.repository.getTurns(id, query);
  } catch {
    return notFound("Session or turn chunk not found");
  }
});
