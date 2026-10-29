import { historyFailure } from "#server/api/_history.ts";
import { sessionId } from "#server/api/_validation.ts";
import { historyRequestSignal } from "#server/live/requestCancellation.ts";
import { useCatalogReadyLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const id = await sessionId(event);
  const runtime = await useCatalogReadyLiveViewerRuntime(event);
  try {
    return await runtime.repository.getApprovalEvidence(id, {
      signal: historyRequestSignal(event),
    });
  } catch (error) {
    return historyFailure(error);
  }
});
