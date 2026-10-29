import { notFound, sessionId } from "#server/api/_validation.ts";
import { useCatalogReadyLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const id = await sessionId(event);
  const runtime = await useCatalogReadyLiveViewerRuntime(event);
  try {
    return runtime.repository.getClassification(id);
  } catch {
    return notFound("Session not found");
  }
});
