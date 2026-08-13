import { describe, expect, it } from "vitest";

import { parseDoctorArguments, parseExportArguments } from "../../../server/export/cliArguments.ts";

describe("static export command arguments", () => {
  it("parses explicit paths and export controls", () => {
    expect(
      parseExportArguments([
        "--codex-home",
        "C:\\Codex home",
        "--output=C:\\viewer output",
        "--offline",
        "--force",
      ]),
    ).toEqual({
      codexHome: "C:\\Codex home",
      output: "C:\\viewer output",
      offline: true,
      force: true,
    });
  });

  it("rejects unknown and incomplete options", () => {
    expect(() => parseExportArguments(["--wat"])).toThrow("Unknown option");
    expect(() => parseExportArguments(["--output"])).toThrow("requires a value");
    expect(() => parseDoctorArguments(["--codex-home"])).toThrow("requires a value");
  });

  it("keeps doctor limited to its read-only Codex-home override", () => {
    expect(parseDoctorArguments(["--codex-home=~/.codex-alt"])).toEqual({
      codexHome: "~/.codex-alt",
    });
    expect(() => parseDoctorArguments(["--force"])).toThrow("Unknown option");
  });
});
