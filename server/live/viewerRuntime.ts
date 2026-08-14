import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { ServerViewerSettings } from "../../shared/types/settings.ts";
import { listCachedSourcePaths } from "../cache/conversationStore.ts";
import { openCacheDatabase } from "../cache/database.ts";
import {
  saveServerViewerConfig,
  validateCodexHome,
  type LoadedServerViewerConfig,
} from "../core/config.ts";
import type { ViewerPaths } from "../core/paths.ts";
import { InvalidationBus } from "./invalidationBus.ts";
import { LiveReconciler } from "./reconciler.ts";
import { LiveConversationRepository } from "./repository.ts";

interface RuntimeContext {
  database: DatabaseSync;
  reconciler: LiveReconciler;
  repository: LiveConversationRepository;
}

export interface LiveViewerRuntimeOptions {
  reconciliationIntervalMs?: number | undefined;
  debounceMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

function contextKey(codexHome: string): string {
  const normalized =
    process.platform === "win32" ? resolve(codexHome).toLowerCase() : resolve(codexHome);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function switchedCacheDatabase(paths: ViewerPaths, codexHome: string): string {
  return join(paths.cacheDir, "live-contexts", contextKey(codexHome), "viewer.sqlite");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function cacheMatchesHome(database: DatabaseSync, codexHome: string): boolean {
  return listCachedSourcePaths(database).every((path) => isWithinRoot(codexHome, path));
}

export class LiveViewerRuntime {
  readonly #paths: ViewerPaths;
  readonly #bus: InvalidationBus;
  readonly #options: LiveViewerRuntimeOptions;
  #settings: ServerViewerSettings;
  #diagnostics: ViewerDiagnostic[];
  #context: RuntimeContext;
  #closed = false;
  #revision = 0;

  private constructor(
    config: LoadedServerViewerConfig,
    context: RuntimeContext,
    bus: InvalidationBus,
    options: LiveViewerRuntimeOptions,
  ) {
    this.#paths = config.paths;
    this.#bus = bus;
    this.#settings = config.settings;
    this.#diagnostics = [...config.diagnostics];
    this.#context = context;
    this.#options = options;
  }

  static async start(
    config: LoadedServerViewerConfig,
    options: LiveViewerRuntimeOptions = {},
  ): Promise<LiveViewerRuntime> {
    let database = openCacheDatabase(config.paths.cacheDatabase, {
      rebuildOnMigrationFailure: true,
    });
    if (!cacheMatchesHome(database, config.settings.codexHome)) {
      database.close();
      database = openCacheDatabase(switchedCacheDatabase(config.paths, config.settings.codexHome), {
        rebuildOnMigrationFailure: true,
      });
    }
    const bus = new InvalidationBus();
    const reconciler = new LiveReconciler({
      bus,
      cacheDir: config.paths.cacheDir,
      codexHome: config.settings.codexHome,
      database,
      debounceMs: options.debounceMs,
      reconciliationIntervalMs: options.reconciliationIntervalMs,
      fetchFavicons: config.settings.fetchFavicons,
      onError: options.onError,
    });
    try {
      await reconciler.start();
    } catch (error) {
      await reconciler.close();
      database.close();
      throw error;
    }
    const runtime = new LiveViewerRuntime(
      config,
      {
        database,
        reconciler,
        repository: new LiveConversationRepository(database, bus),
      },
      bus,
      options,
    );
    return runtime;
  }

  get bus(): InvalidationBus {
    return this.#bus;
  }

  get database(): DatabaseSync {
    return this.#context.database;
  }

  get cacheDir(): string {
    return this.#paths.cacheDir;
  }

  get repository(): LiveConversationRepository {
    return this.#context.repository;
  }

  get settings(): ServerViewerSettings {
    return { ...this.#settings };
  }

  get diagnostics(): ViewerDiagnostic[] {
    return [...this.#diagnostics];
  }

  faviconOrigin(key: string): string | null {
    return this.#context.reconciler.faviconOrigin(key);
  }

  #createContext(database: DatabaseSync, settings: ServerViewerSettings): RuntimeContext {
    const reconciler = new LiveReconciler({
      bus: this.#bus,
      cacheDir: this.#paths.cacheDir,
      codexHome: settings.codexHome,
      database,
      debounceMs: this.#options.debounceMs,
      reconciliationIntervalMs: this.#options.reconciliationIntervalMs,
      fetchFavicons: settings.fetchFavicons,
      onError: this.#options.onError,
    });
    return {
      database,
      reconciler,
      repository: new LiveConversationRepository(database, this.#bus),
    };
  }

  async updateSettings(settings: ServerViewerSettings): Promise<void> {
    if (this.#closed) {
      throw new Error("The live viewer runtime is closed.");
    }
    const diagnostic = await validateCodexHome(settings.codexHome);
    if (diagnostic !== null) {
      throw new Error(diagnostic.message);
    }
    const previous = this.#context;
    const homeChanged = resolve(settings.codexHome) !== resolve(this.#settings.codexHome);
    await previous.reconciler.close();
    const candidateDatabase = homeChanged
      ? openCacheDatabase(switchedCacheDatabase(this.#paths, settings.codexHome), {
          rebuildOnMigrationFailure: true,
        })
      : previous.database;
    const candidate = this.#createContext(candidateDatabase, settings);
    try {
      await candidate.reconciler.start();
      const saved = await saveServerViewerConfig(settings, this.#paths);
      if (!saved.written) {
        this.#diagnostics = saved.diagnostics;
        throw new Error(saved.diagnostics[0]?.message ?? "The viewer settings could not be saved.");
      }
    } catch (error) {
      await candidate.reconciler.close();
      if (homeChanged) {
        candidateDatabase.close();
      }
      const restored = this.#createContext(previous.database, this.#settings);
      await restored.reconciler.start();
      this.#context = restored;
      throw error;
    }
    if (homeChanged) {
      previous.database.close();
    }
    this.#context = candidate;
    this.#settings = { ...settings, codexHome: resolve(settings.codexHome) };
    this.#diagnostics = [];
    this.#revision += 1;
    this.#bus.publish({
      type: "settings.updated",
      ids: ["server"],
      revision: `settings:${this.#revision}`,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#context.reconciler.close();
    this.#context.database.close();
  }
}
