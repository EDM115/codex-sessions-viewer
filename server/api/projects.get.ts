import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../live/requestContext.ts";

export default defineEventHandler((event) => {
  return useLiveViewerRuntime(event).repository.listProjects();
});
