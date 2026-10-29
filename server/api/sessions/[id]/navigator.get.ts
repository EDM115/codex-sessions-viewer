import { historyFailure, historyQuery } from "#server/api/_history.ts";
import { notFound, sessionId } from "#server/api/_validation.ts";
import { historyRequestSignal } from "#server/live/requestCancellation.ts";
import { useCatalogReadyLiveViewerRuntime } from "#server/live/requestContext.ts";
import { historyPageQuerySchema } from "#shared/types/repository.ts";

export default defineEventHandler(async (event) => {
  const id = await sessionId(event);
  if (getQuery(event)["legacy"] !== "1") {
    const query = historyQuery(event, historyPageQuerySchema);
    try {
      const runtime = await useCatalogReadyLiveViewerRuntime(event);
      return await runtime.repository.getHistoryNavigator(id, query, {
        signal: historyRequestSignal(event),
      });
    } catch (error) {
      return historyFailure(error);
    }
  }
  try {
    const runtime = await useCatalogReadyLiveViewerRuntime(event);
    return await runtime.repository.getTurnNavigator(id);
  } catch {
    return notFound("Session not found");
  }
});
