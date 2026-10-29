import { inspectorTarget, notFound, sessionId } from "#server/api/_validation.ts";
import { useCatalogReadyLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const [id, target] = await Promise.all([sessionId(event), inspectorTarget(event)]);
  try {
    const runtime = await useCatalogReadyLiveViewerRuntime(event);
    return await runtime.repository.getInspector(id, target);
  } catch {
    return notFound("Inspector target not found");
  }
});
