import * as z from "zod";

import {
  conversationSummarySchema,
  type ConversationSummary,
  type TurnNavigatorItem,
} from "#shared/types/conversation.ts";
import {
  deepSearchJobSchema,
  type ConversationListItem,
  type ConversationProject,
  type DeepSearchJob,
} from "#shared/types/library.ts";
import {
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
import {
  hydrateStaticInspectorRecord,
  staticInspectorChunkSchema,
  staticLibraryPayloadSchema,
  staticNavigatorPayloadSchema,
  type StaticLibraryPayload,
} from "#shared/types/staticPayloads.ts";

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
const assetManifestSchema = z.object({
  assets: z.array(resolvedAssetSchema),
});
const faviconManifestSchema = z.strictObject({
  version: z.literal(1),
  favicons: z.array(
    z.strictObject({
      origin: z.url(),
      url: z.string().startsWith("/favicons/"),
      sourceUrl: z.url().nullable(),
      mimeType: z.string().nullable(),
      byteSize: z.int().nonnegative().nullable(),
      sha256: z.string().regex(/^[a-f\d]{64}$/u),
    }),
  ),
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

function matchesSession(item: ConversationListItem, query: SessionListQuery): boolean {
  const session = item.summary;
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
  if (query.projectId !== undefined && item.projectId !== query.projectId) {
    return false;
  }
  if (query.parentThreadId === undefined || query.parentThreadId === "__root__") {
    if (item.kind !== "root" || item.parentThreadId !== null) {
      return false;
    }
  } else if (item.kind !== "subagent" || item.parentThreadId !== query.parentThreadId) {
    return false;
  }
  return query.hasMedia === undefined || session.hasMedia === query.hasMedia;
}

function fallbackLibrary(sessions: readonly ConversationSummary[]): StaticLibraryPayload {
  const roots = sessions.filter(({ parentThreadId }) => parentThreadId === null);
  const project: ConversationProject = {
    id: "none",
    name: "No project",
    source: "none",
    hint: null,
    activeCount: roots.filter(({ scope }) => scope === "active").length,
    archivedCount: roots.filter(({ scope }) => scope === "archived").length,
  };
  return staticLibraryPayloadSchema.parse({
    version: 1,
    projects: [project],
    entries: Object.fromEntries(
      sessions.map((session) => [
        session.id,
        {
          kind: session.parentThreadId === null ? "root" : "subagent",
          projectId: "none",
          parentThreadId: session.parentThreadId,
          agentPath: null,
          agentNickname: null,
          agentDepth: session.parentThreadId === null ? null : 1,
          childCount: session.childThreadIds.length,
        },
      ]),
    ),
  });
}

function pagefindFilters(query: SearchQuery): Record<string, string> {
  return {
    scope: query.scope,
    ...(query.model === undefined ? {} : { model: query.model }),
    ...(query.cwd === undefined ? {} : { cwd: encodeURIComponent(query.cwd) }),
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
  const messageId = meta?.["messageId"];
  if (typeof sessionId !== "string" || typeof turnId !== "string" || typeof title !== "string") {
    return null;
  }
  if (messageId !== undefined && (typeof messageId !== "string" || messageId === "")) {
    return null;
  }
  return {
    sessionId,
    turnId,
    messageId: messageId ?? null,
    scope,
    title,
    excerpt: typeof data.excerpt === "string" ? data.excerpt : "",
    score: typeof result.score === "number" && result.score >= 0 ? result.score : 0,
  };
}

export class StaticConversationRepository implements ConversationRepository {
  private indexPromise: Promise<ConversationSummary[]> | null = null;
  private libraryPromise: Promise<StaticLibraryPayload | null> | null = null;
  private pagefindPromise: Promise<PagefindBrowserApi> | null = null;
  private faviconPromise: Promise<ReadonlyMap<string, string>> | null = null;
  private deepSearchSequence = 0;
  private readonly deepSearchJobs = new Map<string, DeepSearchJob>();

  constructor(
    private readonly requester: RepositoryRequester = browserRequest,
    private readonly pagefindLoader: PagefindLoader = loadBrowserPagefind,
  ) {}

  capabilities() {
    return repositoryCapabilitiesForMode("static");
  }

  async listSessions(query: SessionListQuery, options: RepositoryRequestOptions = {}) {
    options.signal?.throwIfAborted();
    const summaries = await this.index(options);
    const library = (await this.library(options)) ?? fallbackLibrary(summaries);
    const sessions = summaries
      .flatMap((summary): ConversationListItem[] => {
        const entry = library.entries[summary.id];
        return entry === undefined ? [] : [{ summary, materialization: "ready", ...entry }];
      })
      .filter((item) => matchesSession(item, query));
    options.signal?.throwIfAborted();
    const offset = cursorOffset(query.cursor);
    const limit = query.limit ?? 20;
    const items = sessions.slice(offset, offset + limit);
    return {
      items,
      nextCursor: offset + items.length < sessions.length ? String(offset + items.length) : null,
      total: sessions.length,
    };
  }

  async listProjects(options: RepositoryRequestOptions = {}) {
    const summaries = await this.index(options);
    return ((await this.library(options)) ?? fallbackLibrary(summaries)).projects;
  }

  async prepareSessions(ids: string[]) {
    return ids.map((id) => ({ id, state: "ready" as const, error: null }));
  }

  async startDeepSearch(
    query: SearchQuery,
    options: RepositoryRequestOptions = {},
  ): Promise<DeepSearchJob> {
    this.deepSearchSequence += 1;
    const now = new Date().toISOString();
    const result = await this.search(query, options);
    const job = deepSearchJobSchema.parse({
      id: `static:${this.deepSearchSequence}`,
      scope: query.scope,
      query: query.query,
      state: "completed",
      total: 0,
      completed: 0,
      failed: 0,
      resultCount: result.total,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    this.deepSearchJobs.set(job.id, job);
    return job;
  }

  async getDeepSearch(id: string): Promise<DeepSearchJob> {
    const job = this.deepSearchJobs.get(id);
    if (job === undefined) {
      throw new Error("Static deep-search job not found.");
    }
    return { ...job };
  }

  async cancelDeepSearch(id: string): Promise<void> {
    const job = this.deepSearchJobs.get(id);
    if (job !== undefined) {
      this.deepSearchJobs.set(id, {
        ...job,
        state: "cancelled",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async search(query: SearchQuery, options: RepositoryRequestOptions = {}) {
    options.signal?.throwIfAborted();
    const pagefind = await this.pagefind();
    const response = await pagefind.search(query.query, { filters: pagefindFilters(query) });
    const offset = cursorOffset(query.cursor);
    const limit = query.limit ?? 50;
    const page = response.results.slice(offset, offset + limit);
    const hits = (await Promise.all(page.map((result) => pagefindHit(result, query.scope)))).filter(
      (hit): hit is SearchHit => hit !== null,
    );
    options.signal?.throwIfAborted();
    return {
      items: hits,
      nextCursor:
        offset + page.length < response.results.length ? String(offset + page.length) : null,
      total: response.results.length,
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
      if (target === undefined) {
        throw new Error("Turn target not found in the static payloads.");
      }
      const targetChunk = navigator.turnChunks[target.turnId];
      if (targetChunk === undefined) {
        throw new Error("Turn target has no static chunk mapping.");
      }
      cursor = String(targetChunk);
    }
    return turnChunkSchema.parse(
      await this.requester(
        `/payloads/sessions/${encodeURIComponent(id)}/turn-${encodeURIComponent(cursor)}.json`,
      ),
    );
  }

  async getInspector(id: string, target: InspectorTarget): Promise<InspectorRecord> {
    const navigator = await this.navigator(id);
    const indexedChunk = navigator.inspectorChunks[`${target.type}:${target.id}`];
    const likelyTurn =
      target.type === "turn"
        ? navigator.items.find((item) => item.turnId === target.id)
        : undefined;
    const chunkIndexes =
      indexedChunk !== undefined
        ? [indexedChunk]
        : likelyTurn === undefined
          ? Array.from({ length: navigator.chunkCount }, (_, index) => index)
          : [navigator.turnChunks[likelyTurn.turnId]].filter(
              (chunkIndex): chunkIndex is number => chunkIndex !== undefined,
            );
    // oxlint-disable no-await-in-loop -- Static inspector chunks are searched in order and stop as soon as the requested record is found.
    for (const chunkIndex of chunkIndexes) {
      const chunk = staticInspectorChunkSchema.parse(
        await this.requester(
          `/payloads/sessions/${encodeURIComponent(id)}/inspector-${chunkIndex}.json`,
        ),
      );
      const found = chunk.records.find(
        (candidate) => candidate.target.type === target.type && candidate.target.id === target.id,
      );
      if (found !== undefined) {
        return hydrateStaticInspectorRecord(chunk, found);
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

  async resolveFavicon(origin: string): Promise<string | null> {
    return (await this.favicons()).get(origin) ?? null;
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

  private library(options: RepositoryRequestOptions): Promise<StaticLibraryPayload | null> {
    this.libraryPromise ??= this.requester("/payloads/projects.json", options)
      .then((value) => {
        const parsed = staticLibraryPayloadSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      })
      .catch(() => null);
    return this.libraryPromise;
  }

  private navigator(id: string) {
    return this.requester(`/payloads/sessions/${encodeURIComponent(id)}/navigator.json`).then(
      (value) => staticNavigatorPayloadSchema.parse(value),
    );
  }

  private pagefind(): Promise<PagefindBrowserApi> {
    this.pagefindPromise ??= this.pagefindLoader();
    return this.pagefindPromise;
  }

  private favicons(): Promise<ReadonlyMap<string, string>> {
    this.faviconPromise ??= this.requester("/payloads/favicons.json")
      .then((value) => {
        const payload = faviconManifestSchema.parse(value);
        return new Map(payload.favicons.map(({ origin, url }) => [origin, url]));
      })
      .catch((error: unknown) => {
        this.faviconPromise = null;
        throw error;
      });
    return this.faviconPromise;
  }
}
