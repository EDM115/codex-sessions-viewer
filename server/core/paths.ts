import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const APPLICATION_NAME = "codex-sessions-viewer";

export interface PathEnvironment {
  APPDATA?: string | undefined;
  CODEX_HOME?: string | undefined;
  LOCALAPPDATA?: string | undefined;
  XDG_CACHE_HOME?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
}

export interface PathResolutionOptions {
  platform?: NodeJS.Platform | undefined;
  homeDir?: string | undefined;
  env?: PathEnvironment | undefined;
}

export interface ViewerPaths {
  configDir: string;
  cacheDir: string;
  generatedDir: string;
  configFile: string;
  cacheDatabase: string;
}

export type CodexHomeSource = "cli" | "config" | "environment" | "default";

export interface CodexHomeResolution {
  path: string;
  source: CodexHomeSource;
}

export interface CodexHomeResolutionOptions extends PathResolutionOptions {
  cliCodexHome?: string | undefined;
  configuredCodexHome?: string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function pathApiFor(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function expandAndResolve(
  value: string,
  homeDir: string,
  pathApi: typeof posix,
): string {
  const homeRelative = value.match(/^~(?:[\\/](.*))?$/);
  if (homeRelative !== null) {
    return pathApi.resolve(homeDir, homeRelative[1] ?? "");
  }

  return pathApi.resolve(value);
}

export function resolveViewerPaths(
  options: PathResolutionOptions = {},
): ViewerPaths {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const pathApi = pathApiFor(platform);

  let configDir: string;
  let cacheDir: string;

  if (platform === "win32") {
    const localAppData =
      nonEmpty(env.LOCALAPPDATA) ?? pathApi.join(homeDir, "AppData", "Local");
    configDir = pathApi.join(localAppData, APPLICATION_NAME);
    cacheDir = pathApi.join(configDir, "cache");
  } else if (platform === "darwin") {
    configDir = pathApi.join(
      homeDir,
      "Library",
      "Application Support",
      APPLICATION_NAME,
    );
    cacheDir = pathApi.join(homeDir, "Library", "Caches", APPLICATION_NAME);
  } else {
    const configRoot =
      nonEmpty(env.XDG_CONFIG_HOME) ?? pathApi.join(homeDir, ".config");
    const cacheRoot =
      nonEmpty(env.XDG_CACHE_HOME) ?? pathApi.join(homeDir, ".cache");
    configDir = pathApi.join(configRoot, APPLICATION_NAME);
    cacheDir = pathApi.join(cacheRoot, APPLICATION_NAME);
  }

  return {
    configDir,
    cacheDir,
    generatedDir: pathApi.join(cacheDir, "generated"),
    configFile: pathApi.join(configDir, "config.json"),
    cacheDatabase: pathApi.join(cacheDir, "viewer.sqlite"),
  };
}

export function resolveCodexHome(
  options: CodexHomeResolutionOptions = {},
): CodexHomeResolution {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const pathApi = pathApiFor(platform);
  const candidates: Array<[CodexHomeSource, string | undefined]> = [
    ["cli", nonEmpty(options.cliCodexHome)],
    ["config", nonEmpty(options.configuredCodexHome)],
    ["environment", nonEmpty(env.CODEX_HOME)],
    ["default", pathApi.join(homeDir, ".codex")],
  ];

  const selected = candidates.find(([, value]) => value !== undefined);
  if (selected === undefined || selected[1] === undefined) {
    throw new Error("Unable to resolve Codex home");
  }

  return {
    path: expandAndResolve(selected[1], homeDir, pathApi),
    source: selected[0],
  };
}
