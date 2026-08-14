import { createEventStream, defineEventHandler } from "h3";

import { sendInvalidationStream } from "../live/eventStream.ts";
import { useLiveViewerRuntime } from "../live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const runtime = useLiveViewerRuntime(event);
  const stream = createEventStream(event);
  await sendInvalidationStream(runtime.bus, stream);
});
