import * as z from "zod";

import { searchMembershipIds } from "#shared/library/searchMembership.ts";
import { buildSidebarGroups, catalogProjectGroups } from "#shared/library/sidebarGroups.ts";
import { isThreadVisible } from "#shared/library/threadVisibility.ts";
import { approvalEvidenceResultSchema } from "#shared/types/approvals.ts";
import {
  conversationSummarySchema,
  type ConversationSummary,
  type TurnNavigatorItem,
} from "#shared/types/conversation.ts";
import {
  historyNavigatorPage,
  type HistoryPage,
  type HistoryTurnWindow,
} from "#shared/types/history.ts";
import {
  catalogSessionMetadataSchema,
  deepSearchJobSchema,
  libraryEntryFromSummary,
  catalogProjectGroupFromLegacy,
  type ConversationListItem,
  type ConversationProject,
  type DeepSearchJob,
  type CatalogProjectGroup,
  type CatalogLibrary,
  type CatalogSessionMetadata,
  sidebarGroupKey,
} from "#shared/types/library.ts";
import {
  canonicalWebsiteUrl,
  linkPreviewSchema,
  type LinkPreview,
} from "#shared/types/linkPreview.ts";
import {
  repositoryCapabilitiesForMode,
  UnsupportedHistoryError,
  resolvedAssetSchema,
  turnChunkSchema,
  type ConversationRepository,
  type HistoryPageQuery,
  type HistoryItemQuery,
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
  historyPageQuerySchema,
  historyItemQuerySchema,
} from "#shared/types/repository.ts";
import {
  STATIC_HISTORY_ITEM_CHUNK,
  readStaticHistoryCursor,
  staticHistoryCursor,
  staticHistoryManifestSchema,
  staticHistoryChunkSchema,
  type StaticHistoryManifest,
} from "#shared/types/staticHistory.ts";
import {
  hydrateStaticInspectorRecord,
  staticInspectorChunkSchema,
  staticLibraryPayloadSchema,
  legacyStaticLibraryPayloadSchema,
  staticNavigatorPayloadSchema,
  type StaticLibraryPayload,
  type LegacyStaticLibraryPayload,
  staticSessionIndexSchema,
} from "#shared/types/staticPayloads.ts";
import type { RepositoryRequester } from "~/repositories/live.ts";

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
    options: { filters: Record<string, string | { any: string[] }> },
  ): Promise<PagefindSearchResponse>;
}

export type PagefindLoader = () => Promise<PagefindBrowserApi>;

const sessionIndexSchema = staticSessionIndexSchema;
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

interface StaticMembership {
  projectId: string | null | undefined;
  groupId: string;
}

const UNRESOLVED_STATIC_GROUP = "section:unresolved-static-v1";
function staticProjection(
  library: LegacyStaticLibraryPayload,
  summaries: readonly ConversationSummary[],
) {
  const groups = library.projects.map(catalogProjectGroupFromLegacy);
  const byId = new Map<string, StaticMembership>();
  const ambiguousGroups = new Set<string>();
  let unresolvedActive = 0;
  let unresolvedArchived = 0;
  for (const summary of summaries) {
    const entry = library.entries[summary.id];
    if (!entry) {
      continue;
    }
    const candidates = library.projects.filter((project) => project.id === entry.projectId);
    const project = candidates.length === 1 ? candidates[0] : undefined;
    if (!project) {
      candidates.forEach((candidate) =>
        ambiguousGroups.add(catalogProjectGroupFromLegacy(candidate).groupId),
      );
      byId.set(summary.id, { projectId: undefined, groupId: UNRESOLVED_STATIC_GROUP });
      if (entry.kind === "root" && entry.parentThreadId === null) {
        if (summary.scope === "active") {
          unresolvedActive += 1;
        } else {
          unresolvedArchived += 1;
        }
      }
      continue;
    }
    const kind = project.sidebar?.kind ?? (project.source === "none" ? "recents" : "project");
    byId.set(summary.id, {
      projectId: kind === "section" ? undefined : kind === "recents" ? null : project.id,
      groupId: catalogProjectGroupFromLegacy(project).groupId,
    });
  }
  const projectedGroups: CatalogProjectGroup[] = groups
    .filter(
      (group, index) => groups.findIndex((other) => other.groupId === group.groupId) === index,
    )
    .map((group) =>
      ambiguousGroups.has(group.groupId)
        ? Object.assign({}, group, {
            activeCount: 0,
            archivedCount: 0,
            diagnostics: [
              "Static v1 does not distinguish the definitions sharing this project ID.",
            ],
          })
        : group.sidebar?.kind === "section"
          ? Object.assign({}, group, {
              diagnostics: [
                "Static v1 preserves this Section grouping but not its underlying project membership.",
              ],
            })
          : group,
    );
  if (unresolvedActive + unresolvedArchived > 0) {
    projectedGroups.push({
      id: "unresolved-static-v1",
      groupId: UNRESOLVED_STATIC_GROUP,
      name: "Unresolved export membership",
      rootPaths: [],
      hostId: null,
      source: "legacy",
      position: null,
      recencyAt: null,
      activeCount: unresolvedActive,
      archivedCount: unresolvedArchived,
      sidebar: {
        kind: "section",
        sectionId: "unresolved-static-v1",
        sectionName: "Unresolved export membership",
      },
      diagnostics: [
        "This v1 export does not identify which group owns these conversations. Their underlying project membership is unknown.",
      ],
    });
  }
  return { groups: projectedGroups, byId };
}

function matchesSession(
  item: ConversationListItem,
  query: SessionListQuery,
  membership: StaticMembership | undefined,
): boolean {
  if (query.parentThreadId !== undefined && query.parentThreadId !== "__root__") {
    return item.kind === "subagent" && item.parentThreadId === query.parentThreadId;
  }
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
  if (query.projectId !== undefined && membership?.projectId !== query.projectId) {
    return false;
  }
  if (query.groupId !== undefined && membership?.groupId !== query.groupId) {
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

function fallbackLibrary(sessions: readonly ConversationSummary[]): LegacyStaticLibraryPayload {
  const roots = sessions.filter(({ parentThreadId }) => parentThreadId === null);
  const project: ConversationProject = {
    id: "none",
    name: "No project",
    source: "none",
    hint: null,
    activeCount: roots.filter(({ scope }) => scope === "active").length,
    archivedCount: roots.filter(({ scope }) => scope === "archived").length,
  };
  return legacyStaticLibraryPayloadSchema.parse({
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
  const parentThreadId = meta?.["parentThreadId"];
  if (typeof sessionId !== "string" || typeof turnId !== "string" || typeof title !== "string") {
    return null;
  }
  if (messageId !== undefined && (typeof messageId !== "string" || messageId === "")) {
    return null;
  }
  return {
    sessionId,
    ...(typeof parentThreadId === "string" && parentThreadId !== "" ? { parentThreadId } : {}),
    turnId,
    messageId: messageId ?? null,
    scope,
    title,
    excerpt: typeof data.excerpt === "string" ? data.excerpt : "",
    score: typeof result.score === "number" && result.score >= 0 ? result.score : 0,
  };
}

export class StaticConversationRepository implements ConversationRepository {
  private readonly historyManifests = new Map<string, Promise<StaticHistoryManifest | null>>();
  private indexPromise: Promise<z.infer<typeof sessionIndexSchema>> | null = null;
  private libraryPromise: Promise<StaticLibraryPayload | null> | null = null;
  private pagefindPromise: Promise<PagefindBrowserApi> | null = null;
  private faviconPromise: Promise<ReadonlyMap<string, string>> | null = null;
  private previewPromise: Promise<ReadonlyMap<string, LinkPreview>> | null = null;
  private assetManifestPromise: Promise<ReadonlyMap<string, ResolvedAsset>> | null = null;
  private deepSearchSequence = 0;
  private readonly deepSearchJobs = new Map<string, DeepSearchJob>();

  private readonly requester: RepositoryRequester;
  private readonly pagefindLoader: PagefindLoader;
  constructor(
    requester: RepositoryRequester = browserRequest,
    pagefindLoader: PagefindLoader = loadBrowserPagefind,
  ) {
    this.requester = requester;
    this.pagefindLoader = pagefindLoader;
  }

  capabilities() {
    return repositoryCapabilitiesForMode("static");
  }

  async listSessions(query: SessionListQuery, options: RepositoryRequestOptions = {}) {
    options.signal?.throwIfAborted();
    const index = await this.index(options);
    const library = await this.library(options);
    if (library?.version === 2) {
      return this.catalogSessions(library.catalog, index.sessions, query);
    }
    if (index.version !== 1) {
      throw new Error("The static v2 catalog is missing or invalid");
    }
    const summaries = index.sessions;
    const legacyLibrary = library ?? fallbackLibrary(summaries);
    const projection = staticProjection(legacyLibrary, summaries);
    const sessions = summaries
      .flatMap((summary): ConversationListItem[] => {
        const entry = legacyLibrary.entries[summary.id];
        return entry === undefined ? [] : [{ summary, materialization: "ready", ...entry }];
      })
      .filter((item) => matchesSession(item, query, projection.byId.get(item.summary.id)));
    options.signal?.throwIfAborted();
    const offset = cursorOffset(query.cursor);
    const limit = query.limit ?? 20;
    const items = sessions
      .slice(offset, offset + limit)
      .map((item) =>
        libraryEntryFromSummary(item, projection.byId.get(item.summary.id)?.projectId ?? null),
      );
    return {
      items,
      nextCursor: offset + items.length < sessions.length ? String(offset + items.length) : null,
      total: sessions.length,
    };
  }

  async listProjects(options: RepositoryRequestOptions = {}) {
    const library = await this.library(options);
    if (library?.version === 2) {
      return catalogProjectGroups(library.catalog);
    }
    const index = await this.index(options);
    if (index.version !== 1) {
      throw new Error("The static v2 catalog is missing or invalid");
    }
    return staticProjection(library ?? fallbackLibrary(index.sessions), index.sessions).groups;
  }

  private catalogSessions(
    catalog: CatalogLibrary,
    summaries: readonly CatalogSessionMetadata[],
    query: SessionListQuery,
  ) {
    const child = query.parentThreadId !== undefined && query.parentThreadId !== "__root__";
    const groups = buildSidebarGroups(catalog, { ...catalog.preferences, scope: query.scope });
    const group =
      query.groupId === undefined
        ? undefined
        : groups.find((candidate) => sidebarGroupKey(candidate) === query.groupId);
    const term = query.query?.trim().toLocaleLowerCase() ?? "";
    const rows = catalog.threads
      .filter((thread) => {
        if (child) {
          return (
            isThreadVisible(thread.classification, "child") &&
            thread.classification.parentThreadId === query.parentThreadId
          );
        }
        if (thread.scope !== query.scope || !isThreadVisible(thread.classification, "root")) {
          return false;
        }
        if (query.projectId !== undefined && thread.projectId !== query.projectId) {
          return false;
        }
        if (query.groupId !== undefined && !group?.threadIds.includes(thread.id)) {
          return false;
        }
        const summary = summaries.find(({ id }) => id === thread.id);
        const project = catalog.projects.find(({ id }) => id === thread.projectId);
        if (
          term &&
          ![thread.title, summary?.cwd, project?.name, ...(project?.rootPaths ?? [])].some(
            (value) => includes(value ?? null, term),
          )
        ) {
          return false;
        }
        return query.cwd === undefined || summary?.cwd === query.cwd;
      })
      .toSorted((a, b) =>
        group
          ? group.threadIds.indexOf(a.id) - group.threadIds.indexOf(b.id)
          : (b.recencyAt ?? -Infinity) - (a.recencyAt ?? -Infinity) || a.id.localeCompare(b.id),
      );
    const offset = cursorOffset(query.cursor);
    const limit = query.limit ?? 20;
    const items = rows.slice(offset, offset + limit).map((thread) => ({
      id: thread.id,
      title: thread.title,
      scope: thread.scope,
      projectId: thread.projectId,
      orderKey: thread.recencyAt === null ? "" : new Date(thread.recencyAt).toISOString(),
      kind: isThreadVisible(thread.classification, "child")
        ? ("subagent" as const)
        : ("root" as const),
      parentThreadId: thread.classification.parentThreadId,
      childCount: catalog.threads.filter(
        (candidate) =>
          isThreadVisible(candidate.classification, "child") &&
          candidate.classification.parentThreadId === thread.id,
      ).length,
      ...(isThreadVisible(thread.classification, "child")
        ? {
            agent: {
              name: thread.classification.agentNickname,
              path: thread.classification.agentPath,
              role: thread.classification.agentRole,
            },
          }
        : {}),
    }));
    return {
      items,
      nextCursor: offset + items.length < rows.length ? String(offset + items.length) : null,
      total: rows.length,
    };
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
    const library = await this.library(options);
    const allowed =
      library?.version === 2 ? new Set(searchMembershipIds(library.catalog, query)) : null;
    if (
      allowed?.size === 0 ||
      (allowed === null && (query.projectId !== undefined || query.groupId !== undefined))
    ) {
      return { items: [], nextCursor: null, total: 0 };
    }
    const pagefind = await this.pagefind();
    const response = await pagefind.search(query.query, {
      filters: {
        ...pagefindFilters(query),
        ...(allowed === null ? {} : { session: { any: [...allowed] } }),
      },
    });
    const offset = cursorOffset(query.cursor);
    const limit = query.limit ?? 50;
    const page = await Promise.all(
      response.results
        .slice(offset, offset + limit)
        .map((result) => pagefindHit(result, query.scope)),
    );
    const hits = page.filter(
      (hit): hit is SearchHit =>
        hit !== null &&
        (allowed === null || allowed.has(hit.sessionId)) &&
        (query.parentThreadId === undefined ||
          query.parentThreadId === "__root__" ||
          hit.parentThreadId === query.parentThreadId),
    );
    options.signal?.throwIfAborted();
    return {
      items: hits,
      nextCursor: offset + limit < response.results.length ? String(offset + limit) : null,
      total: response.results.length,
    };
  }

  async getApprovalEvidence(id: string, options: RepositoryRequestOptions = {}) {
    const evidence = approvalEvidenceResultSchema.parse(
      await this.requester(`/payloads/sessions/${encodeURIComponent(id)}/approvals.json`, options),
    );
    if (evidence.sessionId !== id) {
      throw new Error("Approval evidence belongs to a different session");
    }
    return evidence;
  }

  async getSession(id: string): Promise<ConversationSummary> {
    return summaryPayloadSchema.parse(
      await this.requester(`/payloads/sessions/${encodeURIComponent(id)}/summary.json`),
    ).summary;
  }

  async getSessionMetadata(id: string, options: RepositoryRequestOptions = {}) {
    return catalogSessionMetadataSchema.parse(
      summaryPayloadSchema.parse(
        await this.requester(`/payloads/sessions/${encodeURIComponent(id)}/summary.json`, options),
      ).summary,
    );
  }

  async getHistoryPage(
    id: string,
    query: HistoryPageQuery,
    options: RepositoryRequestOptions = {},
  ): Promise<HistoryPage> {
    query = historyPageQuerySchema.parse(query);
    options.signal?.throwIfAborted();
    const manifest = await this.historyManifest(id, options);
    if (!manifest) {
      throw new UnsupportedHistoryError();
    }
    const limit = query.limit ?? (query.anchor.kind === "latest" ? 5 : 20);
    let end = manifest.turns.length;
    if (query.anchor.kind === "before") {
      end = readStaticHistoryCursor(query.anchor.cursor, manifest, "turn");
    }
    if (query.anchor.kind === "after") {
      end = Math.min(
        manifest.turns.length,
        readStaticHistoryCursor(query.anchor.cursor, manifest, "turn") + limit,
      );
    }
    if (query.anchor.kind === "turn") {
      const targetId = query.anchor.turnId;
      const target = manifest.turns.findIndex((turn) => turn.turnId === targetId);
      if (target < 0) {
        throw new Error("history.static_target_missing");
      }
      end = target + 1;
    }
    if (end > manifest.turns.length) {
      throw new Error("history.invalid_static_cursor");
    }
    const start =
      query.anchor.kind === "after"
        ? readStaticHistoryCursor(query.anchor.cursor, manifest, "turn")
        : Math.max(0, end - limit);
    const turns = await Promise.all(
      manifest.turns
        .slice(start, end)
        .map((turn) =>
          this.getTurnItems(
            id,
            { turnId: turn.turnId, anchor: { kind: "latest" }, limit: 100 },
            options,
          ),
        ),
    );
    options.signal?.throwIfAborted();
    const {
      version: _version,
      turns: _turns,
      sourceGenerations: _generations,
      ...metadata
    } = manifest;
    return {
      ...metadata,
      turns,
      beforeCursor: start > 0 ? staticHistoryCursor(manifest, "turn", start) : null,
      afterCursor: end < manifest.turns.length ? staticHistoryCursor(manifest, "turn", end) : null,
    };
  }

  async getTurnItems(
    id: string,
    query: HistoryItemQuery,
    options: RepositoryRequestOptions = {},
  ): Promise<HistoryTurnWindow> {
    query = historyItemQuerySchema.parse(query);
    options.signal?.throwIfAborted();
    const manifest = await this.historyManifest(id, options);
    if (!manifest) {
      throw new UnsupportedHistoryError();
    }
    const turnIndex = manifest.turns.findIndex((turn) => turn.turnId === query.turnId);
    const turn = manifest.turns[turnIndex];
    if (!turn) {
      throw new Error("history.static_target_missing");
    }
    const limit = query.limit ?? (query.anchor.kind === "opening" ? 2 : 100);
    let start = Math.max(0, turn.itemCount - limit);
    let end = turn.itemCount;
    if (query.anchor.kind === "opening") {
      start = 0;
      end = Math.min(limit, turn.itemCount);
    }
    if (query.anchor.kind === "before") {
      end = readStaticHistoryCursor(query.anchor.cursor, manifest, "item", query.turnId);
      start = Math.max(0, end - limit);
    }
    if (query.anchor.kind === "after") {
      start = readStaticHistoryCursor(query.anchor.cursor, manifest, "item", query.turnId);
      end = Math.min(turn.itemCount, start + limit);
    }
    if (start > turn.itemCount || end > turn.itemCount) {
      throw new Error("history.invalid_static_cursor");
    }
    const first = Math.floor(start / STATIC_HISTORY_ITEM_CHUNK);
    const last = Math.floor(Math.max(start, end - 1) / STATIC_HISTORY_ITEM_CHUNK);
    const chunks = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, index) =>
        this.historyChunk(id, manifest, turnIndex, first + index, options),
      ),
    );
    const base = chunks[0]!.window;
    const items = chunks
      .flatMap(({ window }) => window.items)
      .slice(start % STATIC_HISTORY_ITEM_CHUNK, (start % STATIC_HISTORY_ITEM_CHUNK) + end - start);
    const partial = start > 0 || end < turn.itemCount;
    return {
      ...base,
      items,
      beforeCursor: start > 0 ? staticHistoryCursor(manifest, "item", start, turn.turnId) : null,
      afterCursor:
        end < turn.itemCount ? staticHistoryCursor(manifest, "item", end, turn.turnId) : null,
      itemsView: partial ? "summary" : base.itemsView,
      coverage: partial
        ? {
            ...base.coverage,
            status: base.coverage.status === "complete" ? "partial" : base.coverage.status,
            gaps: [
              ...base.coverage.gaps.filter(({ reason }) => reason !== "saved-items-not-loaded"),
              {
                physicalRolloutId: base.physicalRolloutId,
                turnId: base.turnId,
                reason: "saved-items-not-loaded",
                beforeOrdinal: null,
                afterOrdinal: null,
              },
            ],
          }
        : base.coverage,
    };
  }

  async getHistoryNavigator(
    id: string,
    query: HistoryPageQuery,
    options: RepositoryRequestOptions = {},
  ) {
    return historyNavigatorPage(await this.getHistoryPage(id, query, options));
  }
  prepareHistoryPresentation: ConversationRepository["prepareHistoryPresentation"] = async (
    query,
    options = {},
  ) => {
    options?.signal?.throwIfAborted();
    const manifest = await this.historyManifest(query.threadId, options);
    if (!manifest) {
      throw new UnsupportedHistoryError();
    }
    const index = manifest.turns.findIndex(
      (turn) => turn.turnId === query.turnId && turn.physicalRolloutId === query.physicalRolloutId,
    );
    const chunk = manifest.turns[index]?.itemChunks[query.itemId];
    if (
      chunk === undefined ||
      manifest.historyEpoch !== query.historyEpoch ||
      manifest.contentRevision !== query.contentRevision
    ) {
      throw new Error("history.static_presentation_owner_mismatch");
    }
    const content = await this.historyChunk(query.threadId, manifest, index, chunk, options);
    const saved = content.presentations.find(
      (presentation) =>
        presentation.threadId === query.threadId &&
        presentation.historyEpoch === query.historyEpoch &&
        presentation.contentRevision === query.contentRevision &&
        presentation.physicalRolloutId === query.physicalRolloutId &&
        presentation.turnId === query.turnId &&
        presentation.itemId === query.itemId &&
        presentation.markdown === query.markdown &&
        JSON.stringify(presentation.attachments ?? []) === JSON.stringify(query.attachments ?? []),
    );
    if (!saved) {
      throw new Error("history.static_presentation_missing");
    }
    return saved;
  };

  async supportsHistory(id: string, options: RepositoryRequestOptions = {}) {
    return (await this.historyManifest(id, options)) !== null;
  }

  private historyManifest(
    id: string,
    options: RepositoryRequestOptions,
  ): Promise<StaticHistoryManifest | null> {
    options.signal?.throwIfAborted();
    let pending = this.historyManifests.get(id);
    if (!pending) {
      pending = this.requester(
        `/payloads/sessions/${encodeURIComponent(id)}/history-index.json`,
        options,
      )
        .catch(() => null)
        .then((value) => {
          options.signal?.throwIfAborted();
          if (value === null) {
            return null;
          }
          const manifest = staticHistoryManifestSchema.parse(value);
          if (manifest.threadId !== id) {
            throw new Error("history.static_owner_mismatch");
          }
          return manifest;
        })
        .catch((error: unknown) => {
          this.historyManifests.delete(id);
          throw error;
        });
      this.historyManifests.set(id, pending);
      if (this.historyManifests.size > 32) {
        this.historyManifests.delete(this.historyManifests.keys().next().value!);
      }
    }
    return pending;
  }

  private async historyChunk(
    id: string,
    manifest: StaticHistoryManifest,
    turnIndex: number,
    chunk: number,
    options: RepositoryRequestOptions,
  ) {
    const turn = manifest.turns[turnIndex];
    if (!turn || chunk < 0 || chunk >= turn.chunks) {
      throw new Error("history.invalid_static_cursor");
    }
    const result = staticHistoryChunkSchema.parse(
      await this.requester(
        `/payloads/sessions/${encodeURIComponent(id)}/history-${turnIndex}-${chunk}.json`,
        options,
      ),
    );
    if (
      result.threadId !== id ||
      result.window.turnId !== turn.turnId ||
      result.window.physicalRolloutId !== turn.physicalRolloutId ||
      result.window.historyEpoch !== manifest.historyEpoch ||
      result.window.contentRevision !== manifest.contentRevision
    ) {
      throw new Error("history.static_owner_mismatch");
    }
    options.signal?.throwIfAborted();
    return result;
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
    const asset = (await this.assets()).get(assetId);
    if (asset === undefined) {
      throw new Error("Asset not found in the static payloads.");
    }
    return asset;
  }

  async resolveFavicon(origin: string): Promise<string | null> {
    return (await this.favicons()).get(origin) ?? null;
  }

  async resolveLinkPreview(
    input: string,
    options: RepositoryRequestOptions = {},
  ): Promise<LinkPreview> {
    options.signal?.throwIfAborted();
    const url = canonicalWebsiteUrl(input);
    this.previewPromise ??= this.requester("/payloads/link-previews.json")
      .then((value) => {
        const payload = z
          .strictObject({ version: z.literal(1), previews: z.array(linkPreviewSchema) })
          .parse(value);
        return new Map(payload.previews.map((preview) => [preview.url, preview]));
      })
      .catch(() => new Map<string, LinkPreview>());
    const found = (await this.previewPromise).get(url);
    options.signal?.throwIfAborted();
    return (
      found ?? {
        version: 1,
        provenance: "viewer-enrichment",
        url,
        finalUrl: null,
        revision: "static:missing",
        availability: "unavailable",
        title: null,
        description: null,
        image: null,
        fetchedAt: null,
        retryAt: null,
        reason: "unavailable",
      }
    );
  }

  subscribe(_listener: (event: ViewerInvalidation) => void): () => void {
    return () => undefined;
  }

  private index(options: RepositoryRequestOptions): Promise<z.infer<typeof sessionIndexSchema>> {
    this.indexPromise ??= this.requester("/payloads/sessions/index.json", options)
      .then((value) => sessionIndexSchema.parse(value))
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

  private assets(): Promise<ReadonlyMap<string, ResolvedAsset>> {
    this.assetManifestPromise ??= this.requester("/payloads/assets.json")
      .then((value) => {
        const assets = new Map<string, ResolvedAsset>();
        for (const asset of assetManifestSchema.parse(value).assets) {
          if (assets.has(asset.id)) {
            throw new Error(`Asset manifest contains duplicate static asset ID ${asset.id}.`);
          }
          assets.set(asset.id, asset);
        }
        return assets;
      })
      .catch((error: unknown) => {
        this.assetManifestPromise = null;
        throw error;
      });
    return this.assetManifestPromise;
  }
}
