import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../../live/requestContext.ts";
import { sessionListQuery } from "../_validation.ts";

export default defineEventHandler(async (event) => {
  const query = await sessionListQuery(event);
  return useLiveViewerRuntime(event).repository.listSessions(query);
});
