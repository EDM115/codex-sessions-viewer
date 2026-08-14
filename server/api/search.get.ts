import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../live/requestContext.ts";
import { searchQuery } from "./_validation.ts";

export default defineEventHandler(async (event) => {
  const query = await searchQuery(event);
  return useLiveViewerRuntime(event).repository.search(query);
});
