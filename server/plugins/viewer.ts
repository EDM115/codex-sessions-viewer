import { getHeader, getMethod } from "h3";

import { loadServerViewerConfig } from "../core/config.ts";
import { attachLiveViewerRuntime } from "../live/requestContext.ts";
import { LiveViewerRuntime } from "../live/viewerRuntime.ts";

function configuredPort(): number | undefined {
  const source = process.env["CODEX_VIEWER_PORT"]?.trim();
  if (source === undefined || source === "") {
    return undefined;
  }
  const port = Number(source);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function configuredMediaRoots(): string[] | undefined {
  const source = process.env["CODEX_VIEWER_MEDIA_ROOTS"]?.trim();
  if (source === undefined || source === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(source);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export default defineNitroPlugin(async (nitroApp) => {
  if (useRuntimeConfig().viewerMode !== "live") {
    return;
  }
  console.log("[viewer] Preparing the live conversation catalog...");
  const config = await loadServerViewerConfig({
    cli: {
      codexHome: process.env["CODEX_VIEWER_CODEX_HOME"],
      port: configuredPort(),
      trustedMediaRoots: configuredMediaRoots(),
    },
  });
  const runtime = await LiveViewerRuntime.start(config, {
    initialReconciliation: "deferred",
    onError(error) {
      console.error("[viewer] Live reconciliation failed:", error);
    },
  });
  nitroApp.hooks.hook("request", (event) => {
    attachLiveViewerRuntime(event, runtime);
  });
  nitroApp.hooks.hook("close", async () => {
    await runtime.close();
  });
  let initialReconciliationStarted = false;
  nitroApp.hooks.hook("afterResponse", (event) => {
    if (
      initialReconciliationStarted ||
      getMethod(event) !== "GET" ||
      !getHeader(event, "accept")?.includes("text/html")
    ) {
      return;
    }
    initialReconciliationStarted = true;
    void runtime
      .startInitialReconciliation()
      .then(() => {
        console.log(
          `[viewer] Watching ${runtime.settings.codexHome} without modifying Codex data.`,
        );
        return undefined;
      })
      .catch((error: unknown) => {
        console.error("[viewer] Initial live reconciliation failed:", error);
      });
  });
});
