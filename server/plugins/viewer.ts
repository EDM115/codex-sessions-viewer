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

export default defineNitroPlugin(async (nitroApp) => {
  if (useRuntimeConfig().viewerMode !== "live") {
    return;
  }
  console.log("[viewer] Preparing the live Codex session cache...");
  const config = await loadServerViewerConfig({
    cli: {
      codexHome: process.env["CODEX_VIEWER_CODEX_HOME"],
      port: configuredPort(),
    },
  });
  const runtime = await LiveViewerRuntime.start(config, {
    onError(error) {
      console.error("[viewer] Live reconciliation failed:", error);
    },
  });
  console.log(`[viewer] Watching ${runtime.settings.codexHome} without modifying Codex data.`);
  nitroApp.hooks.hook("request", (event) => {
    attachLiveViewerRuntime(event, runtime);
  });
  nitroApp.hooks.hook("close", async () => {
    await runtime.close();
  });
});
