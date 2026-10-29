import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler((event) => {
  const runtime = useLiveViewerRuntime(event);
  return {
    server: runtime.settings,
    diagnostics: runtime.diagnostics,
  };
});
