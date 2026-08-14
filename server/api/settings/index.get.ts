import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../../live/requestContext.ts";

export default defineEventHandler((event) => {
  const runtime = useLiveViewerRuntime(event);
  return {
    server: runtime.settings,
    diagnostics: runtime.diagnostics,
  };
});
