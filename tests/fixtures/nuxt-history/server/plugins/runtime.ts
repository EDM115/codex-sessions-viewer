import { attachLiveViewerRuntime } from "#server/live/requestContext.ts";

import {
  activeFixtureRuntime,
  assertFixtureOwner,
  instrumentFixtureReads,
} from "../utils/fixtureState.ts";

export default defineNitroPlugin((app) => {
  const close = instrumentFixtureReads();
  app.hooks.hook("request", (event) => {
    const owner = getHeader(event, "x-viewer-fixture-owner");
    if (owner) {
      assertFixtureOwner(owner);
    }
    const runtime = activeFixtureRuntime();
    if (runtime) {
      attachLiveViewerRuntime(event, runtime);
    }
  });
  app.hooks.hook("close", close);
});
