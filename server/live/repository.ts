import type { DatabaseSync } from "node:sqlite";

import {
  repositoryCapabilitiesForMode,
  type ConversationRepository,
  type InspectorTarget,
  type SearchQuery,
  type SessionListQuery,
  type TurnChunkQuery,
} from "../../shared/types/repository.ts";
import { getCachedAsset } from "../cache/assetStore.ts";
import {
  getCachedInspector,
  getCachedSessionSummary,
  getCachedTurnChunk,
  getCachedTurnNavigator,
  listCachedSessions,
} from "../cache/repositoryStore.ts";
import { searchCachedSessions } from "../cache/searchStore.ts";
import { InvalidationBus } from "./invalidationBus.ts";

export class LiveConversationRepository implements ConversationRepository {
  readonly #database: DatabaseSync;
  readonly #bus: InvalidationBus;

  constructor(database: DatabaseSync, bus: InvalidationBus) {
    this.#database = database;
    this.#bus = bus;
  }

  capabilities() {
    return repositoryCapabilitiesForMode("live");
  }

  async listSessions(query: SessionListQuery) {
    return listCachedSessions(this.#database, query);
  }

  async search(query: SearchQuery) {
    return searchCachedSessions(this.#database, query);
  }

  async getSession(id: string) {
    const summary = getCachedSessionSummary(this.#database, id);
    if (summary === null) {
      throw new Error("Session not found");
    }
    return summary;
  }

  async getTurnNavigator(id: string) {
    const navigator = getCachedTurnNavigator(this.#database, id);
    if (navigator === null) {
      throw new Error("Session not found");
    }
    return navigator;
  }

  async getTurns(id: string, query: TurnChunkQuery) {
    const chunk = getCachedTurnChunk(this.#database, id, query);
    if (chunk === null) {
      throw new Error("Session or turn chunk not found");
    }
    return chunk;
  }

  async getInspector(id: string, target: InspectorTarget) {
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
