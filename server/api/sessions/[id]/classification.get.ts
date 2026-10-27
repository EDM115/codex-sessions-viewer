import { defineEventHandler } from "h3";

import { useCatalogReadyLiveViewerRuntime } from "../../../live/requestContext.ts";
import { notFound, sessionId } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const id = await sessionId(event);
  const runtime = await useCatalogReadyLiveViewerRuntime(event);
  try {
    return runtime.repository.getClassification(id);
  } catch {
    return notFound("Session not found");
  }
});
