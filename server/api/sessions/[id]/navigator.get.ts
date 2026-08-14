import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../../../live/requestContext.ts";
import { notFound, sessionId } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const id = await sessionId(event);
  try {
    return await useLiveViewerRuntime(event).repository.getTurnNavigator(id);
  } catch {
    return notFound("Session not found");
  }
});
