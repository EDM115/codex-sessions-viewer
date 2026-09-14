import type { DatabaseSync } from "node:sqlite";

import type { DeepSearchJob } from "../../shared/types/library.ts";
import {
  repositoryCapabilitiesForMode,
  type ConversationRepository,
  type InspectorTarget,
  type SearchQuery,
  type SessionListQuery,
  type TurnChunkQuery,
  type TurnChunk,
} from "../../shared/types/repository.ts";
import { getCachedAsset } from "../cache/assetStore.ts";
import { catalogSession, listCatalogProjects, listCatalogSessions } from "../cache/catalogStore.ts";
import {
  getCachedInspector,
  getCachedSessionSummary,
  getCachedTurnChunk,
  getCachedTurnNavigator,
} from "../cache/repositoryStore.ts";
import { searchCachedSessions } from "../cache/searchStore.ts";
import { InvalidationBus } from "./invalidationBus.ts";

export interface LiveRepositoryMaterializer {
  prepareSessions(ids: readonly string[]): ReturnType<ConversationRepository["prepareSessions"]>;
  ensureMaterialized(id: string): Promise<void>;
  prepareTurnChunk?(chunk: TurnChunk): Promise<TurnChunk>;
  cancelOwner(owner: string): void;
  startDeepSearch(query: SearchQuery): DeepSearchJob;
  getDeepSearch(id: string): DeepSearchJob | null;
  cancelDeepSearch(id: string): boolean;
}

export class LiveConversationRepository implements ConversationRepository {
  readonly #database: DatabaseSync;
  readonly #bus: InvalidationBus;
  readonly #materializer: LiveRepositoryMaterializer;

  constructor(
    database: DatabaseSync,
    bus: InvalidationBus,
    materializer?: LiveRepositoryMaterializer,
  ) {
    this.#database = database;
    this.#bus = bus;
    this.#materializer = materializer ?? {
      async prepareSessions(ids) {
        return ids.map((id) => ({
          id,
          state: getCachedSessionSummary(database, id) === null ? "failed" : "ready",
          error: getCachedSessionSummary(database, id) === null ? "Session not found" : null,
        }));
      },
      async ensureMaterialized() {},
      cancelOwner() {},
      startDeepSearch() {
        throw new Error("Progressive archive search is unavailable for this repository.");
      },
      getDeepSearch() {
        return null;
      },
      cancelDeepSearch() {
        return false;
      },
    };
  }

  capabilities() {
    return repositoryCapabilitiesForMode("live");
  }

  async listSessions(query: SessionListQuery) {
    return listCatalogSessions(this.#database, query);
  }

  async listProjects() {
    return listCatalogProjects(this.#database);
  }

  async prepareSessions(ids: string[]) {
    return this.#materializer.prepareSessions(ids);
  }

  async startDeepSearch(_query: SearchQuery): Promise<DeepSearchJob> {
    return this.#materializer.startDeepSearch(_query);
  }

  async getDeepSearch(_id: string): Promise<DeepSearchJob> {
    const job = this.#materializer.getDeepSearch(_id);
    if (job === null) {
      throw new Error("Deep-search job not found");
    }
    return job;
  }

  async cancelDeepSearch(id: string) {
    if (!this.#materializer.cancelDeepSearch(id)) {
      throw new Error("Deep-search job not found");
    }
  }

  async search(query: SearchQuery) {
    return searchCachedSessions(this.#database, query);
  }

  async getSession(id: string) {
    await this.#materializer.ensureMaterialized(id);
    const summary = getCachedSessionSummary(this.#database, id);
    if (summary === null) {
      throw new Error("Session not found");
    }
    const catalog = catalogSession(this.#database, id);
    return catalog === null
      ? summary
      : {
          ...summary,
          parentThreadId: catalog.parentThreadId,
          childThreadIds: catalog.summary.childThreadIds,
        };
  }

  async getTurnNavigator(id: string) {
    await this.#materializer.ensureMaterialized(id);
    const navigator = getCachedTurnNavigator(this.#database, id);
    if (navigator === null) {
      throw new Error("Session not found");
    }
    return navigator;
  }

  async getTurns(id: string, query: TurnChunkQuery) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- A source revision race gets one bounded retry.
      await this.#materializer.ensureMaterialized(id);
      const chunk = getCachedTurnChunk(this.#database, id, query);
      if (chunk === null) {
        throw new Error("Session or turn chunk not found");
      }
      try {
        if (this.#materializer.prepareTurnChunk === undefined) {
          return chunk;
        }
        // oxlint-disable-next-line no-await-in-loop -- Rich preparation is revision-fenced and retries only after a concurrent change.
        return await this.#materializer.prepareTurnChunk(chunk);
      } catch (error) {
        if (
          attempt > 0 ||
          getCachedSessionSummary(this.#database, id)?.revision === chunk.revision
        ) {
          throw error;
        }
      }
    }
    throw new Error("The conversation changed repeatedly while its page was prepared.");
  }

  async getInspector(id: string, target: InspectorTarget) {
    await this.#materializer.ensureMaterialized(id);
    if (this.#materializer.prepareTurnChunk !== undefined) {
      const turnId =
        target.type === "turn"
          ? target.id
          : this.#database
              .prepare(
                `SELECT turn_id FROM ${target.type === "message" ? "messages" : "activities"} WHERE session_id = ? AND id = ?`,
              )
              .get(id, target.id)?.["turn_id"];
      if (typeof turnId === "string") {
        await this.getTurns(id, { targetTurnId: turnId, limit: 1 });
      }
    }
    const record = getCachedInspector(this.#database, id, target);
    if (record === null) {
      throw new Error("Inspector target not found");
    }
    return record;
  }

  async resolveAsset(assetId: string) {
    const asset = getCachedAsset(this.#database, assetId);
    if (asset === null) {
      throw new Error("Asset not found");
    }
    return {
      ...asset,
      url:
        asset.status === "available" ? `/api/assets/${encodeURIComponent(assetId)}/content` : null,
    };
  }

  async resolveFavicon(origin: string) {
    return `/api/favicons/${Buffer.from(origin).toString("base64url")}`;
  }

  subscribe(listener: Parameters<InvalidationBus["subscribe"]>[0]) {
    return this.#bus.subscribe(listener);
  }
}
