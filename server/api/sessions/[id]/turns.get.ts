import { historyFailure, historyQuery } from "#server/api/_history.ts";
import { notFound, sessionId, turnChunkQuery } from "#server/api/_validation.ts";
import { historyRequestSignal } from "#server/live/requestCancellation.ts";
import { useCatalogReadyLiveViewerRuntime } from "#server/live/requestContext.ts";
import { historyPageQuerySchema } from "#shared/types/repository.ts";

export default defineEventHandler(async (event) => {
  if (getQuery(event)["legacy"] !== "1") {
    const id = await sessionId(event);
    const query = historyQuery(event, historyPageQuerySchema);
    try {
      const runtime = await useCatalogReadyLiveViewerRuntime(event);
      return await runtime.repository.getHistoryPage(id, query, {
        signal: historyRequestSignal(event),
      });
    } catch (error) {
      return historyFailure(error);
    }
  }
  const [id, query] = await Promise.all([sessionId(event), turnChunkQuery(event)]);
  try {
    const runtime = await useCatalogReadyLiveViewerRuntime(event);
    return await runtime.repository.getTurns(id, query);
  } catch {
    return notFound("Session or turn chunk not found");
  }
});
