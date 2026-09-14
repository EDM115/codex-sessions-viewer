import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESENTATION_SETTINGS,
  migratePresentationSettings,
  persistedPresentationSettingsSchema,
  serializePresentationSettings,
} from "../../../shared/types/settings.ts";

describe("presentation settings migration", () => {
  it("fills new defaults while preserving recognized legacy preferences", () => {
    expect(
      migratePresentationSettings({
        theme: "editorial-archive",
        wrapCode: true,
      }),
    ).toEqual({
      theme: "editorial-archive",
      toolCallsDefault: "collapsed",
      reasoningDefault: "collapsed",
      timestampFormat: "both",
      wrapCode: true,
      liveFollow: true,
      turnMinimap: true,
    });
  });

  it("defaults only invalid legacy fields", () => {
    expect(
      migratePresentationSettings({
        theme: "neon-rainbow",
        toolCallsDefault: "always-open",
        wrapCode: true,
      }),
    ).toEqual({
      theme: "midnight-glass",
      toolCallsDefault: "collapsed",
      reasoningDefault: "collapsed",
      timestampFormat: "both",
      wrapCode: true,
      liveFollow: true,
      turnMinimap: true,
    });
  });

  it("serializes and validates the current versioned storage envelope", () => {
    const settings = {
      ...DEFAULT_PRESENTATION_SETTINGS,
      theme: "quiet-precision" as const,
    };
    const persisted = serializePresentationSettings(settings);

    expect(persisted).toEqual({ version: 1, settings });
    expect(persistedPresentationSettingsSchema.parse(persisted)).toEqual(persisted);
  });
});
