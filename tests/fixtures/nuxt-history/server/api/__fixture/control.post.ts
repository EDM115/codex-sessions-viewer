import * as z from "zod";

import { viewerInvalidationSchema } from "#shared/types/repository.ts";

import {
  activeFixtureRuntime,
  closeFixtureRuntime,
  fixtureContent,
  fixtureGate,
  fixtureSnapshot,
  resetFixture,
} from "../../utils/fixtureState.ts";

export default defineEventHandler(async (event) => {
  const input = z
    .discriminatedUnion("action", [
      z.object({ action: z.literal("close") }),
      z.object({ action: z.literal("reset"), root: z.string() }),
      z.object({ action: z.literal("gate"), enabled: z.boolean() }),
      z.object({ action: z.literal("publish"), event: viewerInvalidationSchema }),
      z.object({ action: z.literal("snapshot") }),
      z.object({
        action: z.literal("content"),
        root: z.string(),
        file: z
          .object({
            path: z.string(),
            mimeType: z.string().nullable(),
            sha256: z.string(),
            byteSize: z.number(),
          })
          .nullable(),
      }),
    ])
    .parse(await readBody(event));
  if (input.action === "reset") {
    return resetFixture(input.root);
  }
  if (input.action === "close") {
    await closeFixtureRuntime();
  }
  if (input.action === "gate") {
    fixtureGate(input.enabled);
  }
  if (input.action === "publish") {
    activeFixtureRuntime()?.bus.publish(input.event);
  }
  if (input.action === "content") {
    fixtureContent(input);
  }
  return fixtureSnapshot();
});
