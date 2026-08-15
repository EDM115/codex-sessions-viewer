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
        "--no-index",
      ]),
    ).toEqual({
      codexHome: "C:\\Codex home",
      output: "C:\\viewer output",
      offline: true,
      force: true,
      index: false,
    });
    expect(parseExportArguments([])).toEqual({ offline: false, force: false, index: true });
  });

  it("rejects unknown and incomplete options", () => {
    expect(() => parseExportArguments(["--wat"])).toThrow("Unknown option");
    expect(() => parseExportArguments(["--output"])).toThrow("requires a value");
    expect(() => parseExportArguments(["--codex-home", "--force"])).toThrow("requires a value");
    expect(() => parseExportArguments(["--codex-home="])).toThrow("requires a value");
    expect(() => parseExportArguments(["--output="])).toThrow("requires a value");
    expect(() => parseDoctorArguments(["--codex-home"])).toThrow("requires a value");
    expect(() => parseDoctorArguments(["--codex-home", "--force"])).toThrow("requires a value");
  });

  it("keeps doctor limited to its read-only Codex-home override", () => {
    expect(parseDoctorArguments(["--codex-home=~/.codex-alt"])).toEqual({
      codexHome: "~/.codex-alt",
    });
    expect(parseDoctorArguments([])).toEqual({});
    expect(parseDoctorArguments(["--codex-home", "D:\\Codex"])).toEqual({ codexHome: "D:\\Codex" });
    expect(
      parseExportArguments(["--codex-home=C:\\Codex", "--output", "D:\\Viewer"]),
    ).toMatchObject({ codexHome: "C:\\Codex", output: "D:\\Viewer" });
    expect(() => parseDoctorArguments(["--codex-home", "D:\\Codex", "--force"])).toThrow(
      "Unknown option: --force",
    );
    expect(() => parseDoctorArguments(["--codex-home=D:\\Codex", "--force"])).toThrow(
      "Unknown option: --force",
    );
    expect(() => parseDoctorArguments(["--codex-home="])).toThrow("requires a value");
    expect(() => parseDoctorArguments(["--force"])).toThrow("Unknown option");
  });
});
