import { historyFailure, historyQuery } from "#server/api/_history.ts";
import { sessionId } from "#server/api/_validation.ts";
import { historyRequestSignal } from "#server/live/requestCancellation.ts";
import { useCatalogReadyLiveViewerRuntime } from "#server/live/requestContext.ts";
import { historyItemQuerySchema } from "#shared/types/repository.ts";

export default defineEventHandler(async (event) => {
  const id = await sessionId(event);
  const query = historyQuery(event, historyItemQuerySchema);
  try {
    const runtime = await useCatalogReadyLiveViewerRuntime(event);
    return await runtime.repository.getTurnItems(id, query, {
      signal: historyRequestSignal(event),
    });
  } catch (error) {
    return historyFailure(error);
  }
});
