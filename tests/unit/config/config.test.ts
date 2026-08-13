import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadServerViewerConfig, saveServerViewerConfig } from "../../../server/core/config.ts";
import type { ViewerPaths } from "../../../server/core/paths.ts";

const temporaryDirectories: string[] = [];

async function createFixture(): Promise<{
  root: string;
  paths: ViewerPaths;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-config-"));
  temporaryDirectories.push(root);
  const configDir = join(root, "config");
  const cacheDir = join(root, "cache");

  return {
    root,
    paths: {
      configDir,
      cacheDir,
      generatedDir: join(cacheDir, "generated"),
      configFile: join(configDir, "config.json"),
      cacheDatabase: join(cacheDir, "viewer.sqlite"),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("server viewer configuration", () => {
  it("applies CLI, config, environment, and default precedence", async () => {
    const { root, paths } = await createFixture();
    const cliHome = join(root, "from-cli");
    const configHome = join(root, "from-config");
    const environmentHome = join(root, "from-environment");
    await Promise.all(
      [cliHome, configHome, environmentHome].map((path) => mkdir(path, { recursive: true })),
    );
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(
      paths.configFile,
      JSON.stringify({
        version: 1,
        settings: {
          codexHome: configHome,
          port: 4_100,
          fetchFavicons: false,
        },
      }),
      "utf8",
    );

    const loaded = await loadServerViewerConfig({
      paths,
      cli: { codexHome: cliHome, port: 4_200 },
      env: { CODEX_HOME: environmentHome },
      homeDir: root,
    });

    expect(loaded.settings).toEqual({
      codexHome: cliHome,
      port: 4_200,
      fetchFavicons: false,
    });
    expect(loaded.codexHomeSource).toBe("cli");
    expect(loaded.onboardingRequired).toBe(false);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("recovers from invalid JSON without overwriting it", async () => {
    const { root, paths } = await createFixture();
    const environmentHome = join(root, "from-environment");
    await mkdir(environmentHome, { recursive: true });
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.configFile, "{ invalid", "utf8");

    const loaded = await loadServerViewerConfig({
      paths,
      env: { CODEX_HOME: environmentHome },
      homeDir: root,
    });

    expect(loaded.settings).toEqual({
      codexHome: environmentHome,
      port: 3_000,
      fetchFavicons: true,
    });
    expect(loaded.codexHomeSource).toBe("environment");
    expect(loaded.onboardingRequired).toBe(false);
    expect(loaded.diagnostics.map(({ code }) => code)).toEqual(["config.invalid_json"]);
    expect(await readFile(paths.configFile, "utf8")).toBe("{ invalid");
  });

  it("turns a missing Codex home into onboarding state", async () => {
    const { root, paths } = await createFixture();
    const missingHome = join(root, "missing-codex-home");

    const loaded = await loadServerViewerConfig({
      paths,
      env: { CODEX_HOME: missingHome },
      homeDir: root,
    });

    expect(loaded.settings.codexHome).toBe(missingHome);
    expect(loaded.onboardingRequired).toBe(true);
    expect(loaded.diagnostics.map(({ code }) => code)).toEqual(["codex_home.missing"]);
  });

  it("persists only versioned server settings", async () => {
    const { root, paths } = await createFixture();
    const codexHome = join(root, ".codex");
    await mkdir(codexHome, { recursive: true });

    const result = await saveServerViewerConfig(
      {
        codexHome,
        port: 4_300,
        fetchFavicons: true,
      },
      paths,
    );

    expect(result).toEqual({ written: true, diagnostics: [] });
    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual({
      version: 1,
      settings: {
        codexHome,
        port: 4_300,
        fetchFavicons: true,
      },
    });
  });

  it("refuses to persist a missing Codex-home path", async () => {
    const { root, paths } = await createFixture();
    const missingHome = join(root, "missing-codex-home");

    const result = await saveServerViewerConfig(
      {
        codexHome: missingHome,
        port: 4_300,
        fetchFavicons: true,
      },
      paths,
    );

    expect(result.written).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["codex_home.missing"]);
    await expect(readFile(paths.configFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
