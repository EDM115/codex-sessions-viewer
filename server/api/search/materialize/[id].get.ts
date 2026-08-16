import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../../../live/requestContext.ts";
import { deepSearchId, notFound } from "../../_validation.ts";

export default defineEventHandler(async (event) => {
  const id = await deepSearchId(event);
  try {
    return await useLiveViewerRuntime(event).repository.getDeepSearch(id);
  } catch {
    return notFound("Deep-search job not found");
  }
});
