import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { ViewerRuntimeStatus } from "../../shared/types/repository.ts";
import type { ServerViewerSettings } from "../../shared/types/settings.ts";
import { listCachedSourcePaths } from "../cache/conversationStore.ts";
import { openCacheDatabase } from "../cache/database.ts";
import type { StableJsonlReader } from "../cache/sourceManifest.ts";
import {
  resolvedTrustedMediaRoots,
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
  initialReconciliation?: "blocking" | "background" | "deferred" | undefined;
  reconciliationIntervalMs?: number | undefined;
  debounceMs?: number | undefined;
  readJsonl?: StableJsonlReader | undefined;
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
  #status: ViewerRuntimeStatus = { state: "preparing", message: null };
  #initialReconciliation: Promise<void>;
  #resolveInitialReconciliation!: () => void;
  #rejectInitialReconciliation!: (reason: unknown) => void;
  #initialReconciliationStarted = false;

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
    this.#initialReconciliation = new Promise<void>(
      (resolveInitialReconciliation, rejectInitialReconciliation) => {
        this.#resolveInitialReconciliation = resolveInitialReconciliation;
        this.#rejectInitialReconciliation = rejectInitialReconciliation;
      },
    );
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
      trustedMediaRoots: resolvedTrustedMediaRoots(config.settings),
      readJsonl: options.readJsonl,
      onError: options.onError,
    });
    const runtime = new LiveViewerRuntime(
      config,
      {
        database,
        reconciler,
        repository: new LiveConversationRepository(database, bus, reconciler),
      },
      bus,
      options,
    );
    if (options.initialReconciliation === "deferred") {
      return runtime;
    }
    const initialReconciliation = runtime.startInitialReconciliation();
    if (options.initialReconciliation !== "background") {
      try {
        await initialReconciliation;
      } catch (error) {
        await runtime.close();
        throw error;
      }
    }
    return runtime;
  }

  startInitialReconciliation(): Promise<void> {
    if (this.#initialReconciliationStarted) {
      return this.#initialReconciliation;
    }
    if (this.#closed) {
      this.#rejectInitialReconciliation(new Error("The live viewer runtime is closed."));
      return this.#initialReconciliation;
    }
    this.#initialReconciliationStarted = true;
    void yieldToEventLoop()
      .then(() => this.#context.reconciler.start())
      .then(
        () => {
          if (this.#closed) {
            this.#resolveInitialReconciliation();
            return undefined;
          }
          this.#status = { state: "ready", message: null };
          this.#revision += 1;
          this.#bus.publish({
            type: "library.updated",
            ids: [],
            revision: `startup:${this.#revision}`,
          });
          this.#resolveInitialReconciliation();
          return undefined;
        },
        (error: unknown) => {
          if (!this.#closed) {
            this.#status = {
              state: "error",
              message: error instanceof Error ? error.message : String(error),
            };
          }
          this.#rejectInitialReconciliation(error);
          return undefined;
        },
      );
    return this.#initialReconciliation;
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

  get status(): ViewerRuntimeStatus {
    return { ...this.#status };
  }

  whenReady(): Promise<void> {
    return this.#initialReconciliation;
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
      trustedMediaRoots: resolvedTrustedMediaRoots(settings),
      readJsonl: this.#options.readJsonl,
      onError: this.#options.onError,
    });
    return {
      database,
      reconciler,
      repository: new LiveConversationRepository(database, this.#bus, reconciler),
    };
  }

  async updateSettings(settings: ServerViewerSettings): Promise<void> {
    if (this.#closed) {
      throw new Error("The live viewer runtime is closed.");
    }
    await this.startInitialReconciliation();
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
    if (this.#initialReconciliationStarted) {
      await this.#initialReconciliation.catch(() => undefined);
    } else {
      this.#resolveInitialReconciliation();
    }
    this.#context.database.close();
  }
}
