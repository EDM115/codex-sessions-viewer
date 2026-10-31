import { historyFailure } from "#server/api/_history.ts";
import { sendInvalidationStream } from "#server/live/eventStream.ts";
import {
  useCatalogReadyLiveViewerRuntime,
  useLiveViewerRuntime,
} from "#server/live/requestContext.ts";
import { invalidationSubscriptionQuerySchema } from "#shared/types/repository.ts";

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, (value) =>
    invalidationSubscriptionQuerySchema.parse(value),
  );
  const runtime = query.threadId
    ? await useCatalogReadyLiveViewerRuntime(event)
    : useLiveViewerRuntime(event);
  let release = () => {};
  try {
    release = query.threadId ? runtime.observeSelectedHistory(query.threadId) : () => {};
    const stream = createEventStream(event);
    stream.onClosed(release);
    return await sendInvalidationStream(runtime.bus, stream);
  } catch (error) {
    release();
    return historyFailure(error);
  }
});
