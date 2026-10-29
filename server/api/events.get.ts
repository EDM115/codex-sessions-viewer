import { sendInvalidationStream } from "#server/live/eventStream.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const runtime = useLiveViewerRuntime(event);
  const stream = createEventStream(event);
  return sendInvalidationStream(runtime.bus, stream);
});
