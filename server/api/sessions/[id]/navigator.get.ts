import { defineEventHandler } from "h3";

import { useCatalogReadyLiveViewerRuntime } from "../../../live/requestContext.ts";
import { notFound, sessionId } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const id = await sessionId(event);
  try {
    const runtime = await useCatalogReadyLiveViewerRuntime(event);
    return await runtime.repository.getTurnNavigator(id);
  } catch {
    return notFound("Session not found");
  }
});
