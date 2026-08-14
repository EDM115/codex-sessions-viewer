import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../../../live/requestContext.ts";
import { notFound, sessionId, turnChunkQuery } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const [id, query] = await Promise.all([sessionId(event), turnChunkQuery(event)]);
  try {
    return await useLiveViewerRuntime(event).repository.getTurns(id, query);
  } catch {
    return notFound("Session or turn chunk not found");
  }
});
