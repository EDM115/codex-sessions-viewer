import { describe, expect, it } from "vitest";

import { resolveCodexHome, resolveViewerPaths } from "../../../server/core/paths.ts";

describe("viewer-owned paths", () => {
  it("uses LOCALAPPDATA as the single Windows viewer root", () => {
    expect(
      resolveViewerPaths({
        platform: "win32",
        homeDir: "C:\\Users\\dev",
        env: { LOCALAPPDATA: "D:\\Local" },
      }),
    ).toEqual({
      configDir: "D:\\Local\\codex-sessions-viewer",
      cacheDir: "D:\\Local\\codex-sessions-viewer\\cache",
      generatedDir: "D:\\Local\\codex-sessions-viewer\\cache\\generated",
      configFile: "D:\\Local\\codex-sessions-viewer\\config.json",
      cacheDatabase: "D:\\Local\\codex-sessions-viewer\\cache\\viewer.sqlite",
    });
  });

  it("uses Application Support and Caches on macOS", () => {
    expect(
      resolveViewerPaths({
        platform: "darwin",
        homeDir: "/Users/dev",
        env: {},
      }),
    ).toEqual({
      configDir: "/Users/dev/Library/Application Support/codex-sessions-viewer",
      cacheDir: "/Users/dev/Library/Caches/codex-sessions-viewer",
      generatedDir: "/Users/dev/Library/Caches/codex-sessions-viewer/generated",
      configFile: "/Users/dev/Library/Application Support/codex-sessions-viewer/config.json",
      cacheDatabase: "/Users/dev/Library/Caches/codex-sessions-viewer/viewer.sqlite",
    });
  });

  it("honors XDG config and cache roots on Linux", () => {
    expect(
      resolveViewerPaths({
        platform: "linux",
        homeDir: "/home/dev",
        env: {
          XDG_CONFIG_HOME: "/mnt/config",
          XDG_CACHE_HOME: "/mnt/cache",
        },
      }),
    ).toEqual({
      configDir: "/mnt/config/codex-sessions-viewer",
      cacheDir: "/mnt/cache/codex-sessions-viewer",
      generatedDir: "/mnt/cache/codex-sessions-viewer/generated",
      configFile: "/mnt/config/codex-sessions-viewer/config.json",
      cacheDatabase: "/mnt/cache/codex-sessions-viewer/viewer.sqlite",
    });
  });

  it("falls back to .config and .cache on Linux", () => {
    const paths = resolveViewerPaths({
      platform: "linux",
      homeDir: "/home/dev",
      env: {},
    });

    expect(paths.configDir).toBe("/home/dev/.config/codex-sessions-viewer");
    expect(paths.cacheDir).toBe("/home/dev/.cache/codex-sessions-viewer");
  });
});

describe("Codex-home precedence", () => {
  const baseOptions = {
    platform: "linux" as const,
    homeDir: "/home/dev",
    env: { CODEX_HOME: "/from-environment" },
  };

  it("prefers CLI over config, environment, and fallback", () => {
    expect(
      resolveCodexHome({
        ...baseOptions,
        cliCodexHome: "/from-cli",
        configuredCodexHome: "/from-config",
      }),
    ).toEqual({ path: "/from-cli", source: "cli" });
  });

  it("prefers config over environment and fallback", () => {
    expect(
      resolveCodexHome({
        ...baseOptions,
        configuredCodexHome: "~/configured-codex",
      }),
    ).toEqual({
      path: "/home/dev/configured-codex",
      source: "config",
    });
  });

  it("uses CODEX_HOME before the default", () => {
    expect(resolveCodexHome(baseOptions)).toEqual({
      path: "/from-environment",
      source: "environment",
    });
  });

  it("falls back to the home-directory .codex folder", () => {
    expect(resolveCodexHome({ ...baseOptions, env: {} })).toEqual({
      path: "/home/dev/.codex",
      source: "default",
    });
  });
});
