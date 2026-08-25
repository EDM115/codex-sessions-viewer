import { createError, type H3Event } from "h3";

import type { LiveViewerRuntime } from "./viewerRuntime.ts";

declare module "h3" {
  interface H3EventContext {
    viewerRuntime?: LiveViewerRuntime | undefined;
  }
}

export function attachLiveViewerRuntime(event: H3Event, runtime: LiveViewerRuntime): void {
  event.context.viewerRuntime = runtime;
}

export function useLiveViewerRuntime(event: H3Event): LiveViewerRuntime {
  const runtime = event.context.viewerRuntime;
  if (runtime === undefined) {
    throw createError({ statusCode: 503, statusMessage: "Live viewer is unavailable" });
  }
  return runtime;
}

export async function useCatalogReadyLiveViewerRuntime(event: H3Event): Promise<LiveViewerRuntime> {
  const runtime = useLiveViewerRuntime(event);
  if (runtime.status.state === "preparing") {
    await runtime.startInitialReconciliation();
  }
  return runtime;
}
