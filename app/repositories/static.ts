import * as z from "zod";

import {
  conversationSummarySchema,
  turnNavigatorItemSchema,
  type ConversationSummary,
  type TurnNavigatorItem,
} from "#shared/types/conversation.ts";
import {
  inspectorRecordSchema,
  repositoryCapabilitiesForMode,
  resolvedAssetSchema,
  turnChunkSchema,
  type ConversationRepository,
  type InspectorRecord,
  type InspectorTarget,
  type RepositoryRequestOptions,
  type ResolvedAsset,
  type SearchHit,
  type SearchQuery,
  type SessionListQuery,
  type TurnChunk,
  type TurnChunkQuery,
  type ViewerInvalidation,
} from "#shared/types/repository.ts";

import type { RepositoryRequester } from "./live.ts";

interface PagefindResultData {
  excerpt?: unknown;
  meta?: unknown;
}

interface PagefindResult {
  score?: unknown;
  data(): Promise<PagefindResultData>;
}

export interface PagefindSearchResponse {
  results: PagefindResult[];
}

export interface PagefindBrowserApi {
  search(
    query: string,
    options: { filters: Record<string, string> },
  ): Promise<PagefindSearchResponse>;
}

export type PagefindLoader = () => Promise<PagefindBrowserApi>;

const sessionIndexSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.array(conversationSummarySchema),
});
const summaryPayloadSchema = z.object({ summary: conversationSummarySchema });
const navigatorPayloadSchema = z.object({
  sessionId: z.string().min(1),
  revision: z.string().min(1),
  chunkSize: z.int().positive(),
  items: z.array(turnNavigatorItemSchema),
});
const inspectorChunkSchema = z.object({
  records: z.array(inspectorRecordSchema),
});
const assetManifestSchema = z.object({
  assets: z.array(resolvedAssetSchema),
});

async function browserRequest(
  path: string,
  options: RepositoryRequestOptions = {},
): Promise<unknown> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Static viewer payload request failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<unknown>;
}

async function loadBrowserPagefind(): Promise<PagefindBrowserApi> {
  const pagefindUrl = "/pagefind/pagefind.js";
  const loaded: unknown = await import(/* @vite-ignore */ pagefindUrl);
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("search" in loaded) ||
    typeof loaded.search !== "function"
  ) {
    throw new Error("The bundled Pagefind search module is unavailable.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The single browser-module method is checked above and every returned hit is validated before use.
  return loaded as PagefindBrowserApi;
}

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function includes(value: string | null, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

function matchesSession(session: ConversationSummary, query: SessionListQuery): boolean {
  if (session.scope !== query.scope) {
    return false;
  }
  if (query.query !== undefined && query.query.trim() !== "") {
    const term = query.query.trim().toLocaleLowerCase();
    if (
      !includes(session.title, term) &&
      !includes(session.preview, term) &&
      !includes(session.cwd, term)
    ) {
      return false;
    }
  }
  if (query.model !== undefined && !session.models.includes(query.model)) {
    return false;
  }
  if (query.cwd !== undefined && session.cwd !== query.cwd) {
    return false;
  }
  if (query.tool !== undefined && !(query.tool in session.toolCounts)) {
    return false;
  }
  return query.hasMedia === undefined || session.hasMedia === query.hasMedia;
}

function pagefindFilters(query: SearchQuery): Record<string, string> {
  return {
    scope: query.scope,
    ...(query.model === undefined ? {} : { model: query.model }),
    ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
    ...(query.tool === undefined ? {} : { tool: query.tool }),
    ...(query.hasMedia === undefined ? {} : { media: String(query.hasMedia) }),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

async function pagefindHit(
  result: PagefindResult,
  scope: SearchQuery["scope"],
): Promise<SearchHit | null> {
  const data = await result.data();
  const meta = record(data.meta);
  const sessionId = meta?.["sessionId"];
  const turnId = meta?.["turnId"];
  const title = meta?.["title"];
  if (typeof sessionId !== "string" || typeof turnId !== "string" || typeof title !== "string") {
    return null;
  }
  return {
    sessionId,
    turnId,
    messageId: null,
    scope,
    title,
    excerpt: typeof data.excerpt === "string" ? data.excerpt : "",
    score: typeof result.score === "number" && result.score >= 0 ? result.score : 0,
  };
}

export class StaticConversationRepository implements ConversationRepository {
  private indexPromise: Promise<ConversationSummary[]> | null = null;
  private pagefindPromise: Promise<PagefindBrowserApi> | null = null;

  constructor(
    private readonly requester: RepositoryRequester = browserRequest,
    private readonly pagefindLoader: PagefindLoader = loadBrowserPagefind,
  ) {}

  capabilities() {
    return repositoryCapabilitiesForMode("static");
  }

  async listSessions(query: SessionListQuery, options: RepositoryRequestOptions = {}) {
    options.signal?.throwIfAborted();
    const sessions = (await this.index(options)).filter((session) =>
      matchesSession(session, query),
    );
    options.signal?.throwIfAborted();
    const offset = cursorOffset(query.cursor);
    const limit = query.limit ?? 50;
    const items = sessions.slice(offset, offset + limit);
    return {
      items,
      nextCursor: offset + items.length < sessions.length ? String(offset + items.length) : null,
      total: sessions.length,
    };
  }

  async search(query: SearchQuery, options: RepositoryRequestOptions = {}) {
    options.signal?.throwIfAborted();
    const pagefind = await this.pagefind();
    const response = await pagefind.search(query.query, { filters: pagefindFilters(query) });
    const hits = (
      await Promise.all(response.results.map((result) => pagefindHit(result, query.scope)))
    ).filter((hit): hit is SearchHit => hit !== null);
    options.signal?.throwIfAborted();
    const offset = cursorOffset(query.cursor);
    const limit = query.limit ?? 50;
    const items = hits.slice(offset, offset + limit);
    return {
      items,
      nextCursor: offset + items.length < hits.length ? String(offset + items.length) : null,
      total: hits.length,
    };
  }

  async getSession(id: string): Promise<ConversationSummary> {
    return summaryPayloadSchema.parse(
      await this.requester(`/payloads/sessions/${encodeURIComponent(id)}/summary.json`),
    ).summary;
  }

  async getTurnNavigator(id: string): Promise<TurnNavigatorItem[]> {
    return (await this.navigator(id)).items;
  }

  async getTurns(id: string, query: TurnChunkQuery): Promise<TurnChunk> {
    let cursor = query.cursor ?? "0";
    if (query.targetTurnId !== undefined) {
      const navigator = await this.navigator(id);
      const target = navigator.items.find((item) => item.turnId === query.targetTurnId);
      if (target !== undefined) {
        cursor = String(Math.floor(target.index / navigator.chunkSize));
      }
    }
    return turnChunkSchema.parse(
      await this.requester(
        `/payloads/sessions/${encodeURIComponent(id)}/turn-${encodeURIComponent(cursor)}.json`,
      ),
    );
  }

  async getInspector(id: string, target: InspectorTarget): Promise<InspectorRecord> {
    const navigator = await this.navigator(id);
    const likelyTurn =
      target.type === "turn"
        ? navigator.items.find((item) => item.turnId === target.id)
        : undefined;
    const chunkIndexes =
      likelyTurn === undefined
        ? Array.from(
            { length: Math.ceil(navigator.items.length / navigator.chunkSize) },
            (_, index) => index,
          )
        : [Math.floor(likelyTurn.index / navigator.chunkSize)];
    // oxlint-disable no-await-in-loop -- Static inspector chunks are searched in order and stop as soon as the requested record is found.
    for (const chunkIndex of chunkIndexes) {
      const chunk = inspectorChunkSchema.parse(
        await this.requester(
          `/payloads/sessions/${encodeURIComponent(id)}/inspector-${chunkIndex}.json`,
        ),
      );
      const found = chunk.records.find(
        (candidate) => candidate.target.type === target.type && candidate.target.id === target.id,
      );
      if (found !== undefined) {
        return found;
      }
    }
    // oxlint-enable no-await-in-loop
    throw new Error("Inspector target not found in the static payloads.");
  }

  async resolveAsset(assetId: string): Promise<ResolvedAsset> {
    const manifest = assetManifestSchema.parse(await this.requester("/payloads/assets.json"));
    const asset = manifest.assets.find(({ id }) => id === assetId);
    if (asset === undefined) {
      throw new Error("Asset not found in the static payloads.");
    }
    return asset;
  }

  subscribe(_listener: (event: ViewerInvalidation) => void): () => void {
    return () => undefined;
  }

  private index(options: RepositoryRequestOptions): Promise<ConversationSummary[]> {
    this.indexPromise ??= this.requester("/payloads/sessions/index.json", options)
      .then((value) => sessionIndexSchema.parse(value).sessions)
      .catch((error: unknown) => {
        this.indexPromise = null;
        throw error;
      });
    return this.indexPromise;
  }

  private navigator(id: string) {
    return this.requester(`/payloads/sessions/${encodeURIComponent(id)}/navigator.json`).then(
      (value) => navigatorPayloadSchema.parse(value),
    );
  }

  private pagefind(): Promise<PagefindBrowserApi> {
    this.pagefindPromise ??= this.pagefindLoader();
    return this.pagefindPromise;
  }
}
