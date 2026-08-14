import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../../../live/requestContext.ts";
import { inspectorTarget, notFound, sessionId } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const [id, target] = await Promise.all([sessionId(event), inspectorTarget(event)]);
  try {
    return await useLiveViewerRuntime(event).repository.getInspector(id, target);
  } catch {
    return notFound("Inspector target not found");
  }
});
