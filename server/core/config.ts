import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import {
  DEFAULT_FETCH_FAVICONS,
  DEFAULT_SERVER_PORT,
  persistedServerSettingsSchema,
  serverViewerSettingsSchema,
  type ServerViewerSettings,
} from "../../shared/types/settings.ts";
import {
  resolveCodexHome,
  resolveViewerPaths,
  type CodexHomeSource,
  type PathResolutionOptions,
  type ViewerPaths,
} from "./paths.ts";

export interface ServerConfigCliOptions {
  codexHome?: string | undefined;
  port?: number | undefined;
  fetchFavicons?: boolean | undefined;
  trustedMediaRoots?: string[] | undefined;
}

export interface LoadServerViewerConfigOptions extends PathResolutionOptions {
  paths?: ViewerPaths | undefined;
  cli?: ServerConfigCliOptions | undefined;
}

export interface LoadedServerViewerConfig {
  settings: ServerViewerSettings;
  paths: ViewerPaths;
  codexHomeSource: CodexHomeSource;
  onboardingRequired: boolean;
  diagnostics: ViewerDiagnostic[];
}

export interface SaveServerViewerConfigResult {
  written: boolean;
  diagnostics: ViewerDiagnostic[];
}

interface PersistedConfigReadResult {
  settings: ServerViewerSettings | null;
  diagnostics: ViewerDiagnostic[];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function readPersistedConfig(configFile: string): Promise<PersistedConfigReadResult> {
  let source: string;
  try {
    source = await readFile(configFile, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { settings: null, diagnostics: [] };
    }

    return {
      settings: null,
      diagnostics: [
        createViewerDiagnostic({
          code: "config.unreadable",
          severity: "warning",
          area: "config",
          message: "The viewer configuration could not be read.",
          path: configFile,
        }),
      ],
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source);
  } catch {
    return {
      settings: null,
      diagnostics: [
        createViewerDiagnostic({
          code: "config.invalid_json",
          severity: "warning",
          area: "config",
          message: "The viewer configuration contains invalid JSON.",
          path: configFile,
        }),
      ],
    };
  }

  const parsedConfig = persistedServerSettingsSchema.safeParse(parsedJson);
  if (!parsedConfig.success) {
    return {
      settings: null,
      diagnostics: [
        createViewerDiagnostic({
          code: "config.invalid_settings",
          severity: "warning",
          area: "config",
          message: "The viewer configuration does not match the current schema.",
          path: configFile,
          details: { issueCount: parsedConfig.error.issues.length },
        }),
      ],
    };
  }

  return { settings: parsedConfig.data.settings, diagnostics: [] };
}

export async function validateCodexHome(codexHome: string): Promise<ViewerDiagnostic | null> {
  try {
    const codexHomeStats = await stat(codexHome);
    if (!codexHomeStats.isDirectory()) {
      return createViewerDiagnostic({
        code: "codex_home.not_directory",
        severity: "warning",
        area: "config",
        message: "The selected Codex home is not a directory.",
        path: codexHome,
      });
    }
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return createViewerDiagnostic({
        code: "codex_home.missing",
        severity: "warning",
        area: "config",
        message: "The selected Codex home does not exist.",
        path: codexHome,
      });
    }

    return createViewerDiagnostic({
      code: "codex_home.unreadable",
      severity: "warning",
      area: "config",
      message: "The selected Codex home could not be inspected.",
      path: codexHome,
    });
  }

  return null;
}

export async function loadServerViewerConfig(
  options: LoadServerViewerConfigOptions = {},
): Promise<LoadedServerViewerConfig> {
  const paths = options.paths ?? resolveViewerPaths(options);
  const persisted = await readPersistedConfig(paths.configFile);
  const codexHome = resolveCodexHome({
    platform: options["platform"],
    homeDir: options["homeDir"],
    env: options["env"],
    cliCodexHome: options["cli"]?.codexHome,
    configuredCodexHome: persisted.settings?.codexHome,
  });
  const trustedMediaRoots =
    options["cli"]?.trustedMediaRoots ?? persisted.settings?.trustedMediaRoots;
  const settingsInput = {
    codexHome: codexHome.path,
    port: options["cli"]?.port ?? persisted.settings?.port ?? DEFAULT_SERVER_PORT,
    fetchFavicons:
      options["cli"]?.fetchFavicons ?? persisted.settings?.fetchFavicons ?? DEFAULT_FETCH_FAVICONS,
    ...(trustedMediaRoots === undefined ? {} : { trustedMediaRoots }),
  };
  const parsedSettings = serverViewerSettingsSchema.safeParse(settingsInput);
  const diagnostics = [...persisted.diagnostics];
  const settings = parsedSettings.success
    ? parsedSettings.data
    : {
        codexHome: codexHome.path,
        port: DEFAULT_SERVER_PORT,
        fetchFavicons: DEFAULT_FETCH_FAVICONS,
      };

  if (!parsedSettings.success) {
    diagnostics.push(
      createViewerDiagnostic({
        code: "config.invalid_settings",
        severity: "warning",
        area: "config",
        message: "Invalid server settings were replaced with safe defaults.",
        path: paths.configFile,
        details: { issueCount: parsedSettings.error.issues.length },
      }),
    );
  }

  const codexHomeDiagnostic = await validateCodexHome(settings.codexHome);
  if (codexHomeDiagnostic !== null) {
    diagnostics.push(codexHomeDiagnostic);
  }

  return {
    settings,
    paths,
    codexHomeSource: codexHome.source,
    onboardingRequired: codexHomeDiagnostic !== null,
    diagnostics,
  };
}

export function resolvedTrustedMediaRoots(settings: ServerViewerSettings): string[] {
  return settings.trustedMediaRoots ?? [join(settings.codexHome, "attachments")];
}

export async function saveServerViewerConfig(
  settings: ServerViewerSettings,
  paths = resolveViewerPaths(),
): Promise<SaveServerViewerConfigResult> {
  const parsedSettings = serverViewerSettingsSchema.safeParse(settings);
  if (!parsedSettings.success) {
    return {
      written: false,
      diagnostics: [
        createViewerDiagnostic({
          code: "config.invalid_settings",
          severity: "warning",
          area: "config",
          message: "The server settings were not saved because they are invalid.",
          path: paths.configFile,
          details: { issueCount: parsedSettings.error.issues.length },
        }),
      ],
    };
  }

  const codexHomeDiagnostic = await validateCodexHome(parsedSettings.data.codexHome);
  if (codexHomeDiagnostic !== null) {
    return { written: false, diagnostics: [codexHomeDiagnostic] };
  }

  const temporaryFile = `${paths.configFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(paths.configDir, { recursive: true });
    const persisted = persistedServerSettingsSchema.parse({
      version: 1,
      settings: parsedSettings.data,
    });
    await writeFile(temporaryFile, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryFile, paths.configFile);
  } catch {
    return {
      written: false,
      diagnostics: [
        createViewerDiagnostic({
          code: "config.write_failed",
          severity: "error",
          area: "config",
          message: "The viewer configuration could not be saved.",
          path: paths.configFile,
        }),
      ],
    };
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => undefined);
  }

  return { written: true, diagnostics: [] };
}
