import { defineEventHandler } from "h3";

import { useCatalogReadyLiveViewerRuntime } from "../../../live/requestContext.ts";
import { inspectorTarget, notFound, sessionId } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const [id, target] = await Promise.all([sessionId(event), inspectorTarget(event)]);
  try {
    const runtime = await useCatalogReadyLiveViewerRuntime(event);
    return await runtime.repository.getInspector(id, target);
  } catch {
    return notFound("Inspector target not found");
  }
});
