import {
  conversationSummarySchema,
  type ConversationSummary,
  type TurnNavigatorItem,
} from "#shared/types/conversation.ts";
import {
  conversationProjectsSchema,
  deepSearchJobSchema,
  preparationResultsSchema,
  type DeepSearchJob,
  type PreparationResult,
} from "#shared/types/library.ts";
import {
  inspectorRecordSchema,
  repositoryCapabilitiesForMode,
  resolvedAssetSchema,
  searchResponseSchema,
  sessionListResponseSchema,
  turnChunkSchema,
  turnNavigatorResponseSchema,
  viewerInvalidationSchema,
  type ConversationRepository,
  type InspectorRecord,
  type InspectorTarget,
  type ResolvedAsset,
  type RepositoryRequestOptions,
  type SearchQuery,
  type SessionListQuery,
  type TurnChunk,
  type TurnChunkQuery,
  type ViewerInvalidation,
} from "#shared/types/repository.ts";

import { publishFaviconAvailability } from "../components/content/faviconAvailability.ts";

export interface RepositoryRequesterOptions extends RepositoryRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}

export type RepositoryRequester = (
  path: string,
  options?: RepositoryRequesterOptions,
) => Promise<unknown>;

function queryString(input: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input) as Array<[string, unknown]>) {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      query.set(key, String(value));
    }
  }
  const encoded = query.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function request(path: string, options: RepositoryRequesterOptions = {}): Promise<unknown> {
  const response = await fetch(path, {
    method: options.method,
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    credentials: "same-origin",
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(`Viewer API request failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<unknown>;
}

export class LiveApiConversationRepository implements ConversationRepository {
  constructor(private readonly requester: RepositoryRequester = request) {}

  capabilities() {
    return repositoryCapabilitiesForMode("live");
  }

  async listSessions(query: SessionListQuery, options: RepositoryRequestOptions = {}) {
    return sessionListResponseSchema.parse(
      await this.requester(`/api/sessions${queryString(query)}`, options),
    );
  }

  async listProjects(options: RepositoryRequestOptions = {}) {
    return conversationProjectsSchema.parse(await this.requester("/api/projects", options));
  }

  async prepareSessions(ids: string[], options: RepositoryRequestOptions = {}) {
    const unique = [...new Set(ids)];
    const results: PreparationResult[] = [];
    // oxlint-disable no-await-in-loop -- The API contract intentionally bounds every preparation mutation to 20 IDs and preserves batch order.
    for (let offset = 0; offset < unique.length; offset += 20) {
      const batch = unique.slice(offset, offset + 20);
      const prepared = preparationResultsSchema.parse(
        await this.requester("/api/sessions/prepare", {
          ...options,
          method: "POST",
          body: { ids: batch },
        }),
      );
      results.push(...prepared);
    }
    // oxlint-enable no-await-in-loop
    return results;
  }

  async startDeepSearch(
    query: SearchQuery,
    options: RepositoryRequestOptions = {},
  ): Promise<DeepSearchJob> {
    const { cursor: _cursor, limit: _limit, ...body } = query;
    return deepSearchJobSchema.parse(
      await this.requester("/api/search/materialize", {
        ...options,
        method: "POST",
        body,
      }),
    );
  }

  async getDeepSearch(id: string, options: RepositoryRequestOptions = {}) {
    return deepSearchJobSchema.parse(
      await this.requester(`/api/search/materialize/${encodeURIComponent(id)}`, options),
    );
  }

  async cancelDeepSearch(id: string, options: RepositoryRequestOptions = {}) {
    await this.requester(`/api/search/materialize/${encodeURIComponent(id)}`, {
      ...options,
      method: "DELETE",
    });
  }

  async search(query: SearchQuery, options: RepositoryRequestOptions = {}) {
    return searchResponseSchema.parse(
      await this.requester(`/api/search${queryString(query)}`, options),
    );
  }

  async getSession(id: string): Promise<ConversationSummary> {
    return conversationSummarySchema.parse(
      await this.requester(`/api/sessions/${encodeURIComponent(id)}`),
    );
  }

  async getTurnNavigator(id: string): Promise<TurnNavigatorItem[]> {
    return turnNavigatorResponseSchema.parse(
      await this.requester(`/api/sessions/${encodeURIComponent(id)}/navigator`),
    );
  }

  async getTurns(id: string, query: TurnChunkQuery): Promise<TurnChunk> {
    return turnChunkSchema.parse(
      await this.requester(`/api/sessions/${encodeURIComponent(id)}/turns${queryString(query)}`),
    );
  }

  async getInspector(id: string, target: InspectorTarget): Promise<InspectorRecord> {
    return inspectorRecordSchema.parse(
      await this.requester(
        `/api/sessions/${encodeURIComponent(id)}/inspector${queryString(target)}`,
      ),
    );
  }

  async resolveAsset(assetId: string): Promise<ResolvedAsset> {
    return resolvedAssetSchema.parse(
      await this.requester(`/api/assets/${encodeURIComponent(assetId)}`),
    );
  }

  async resolveFavicon(origin: string): Promise<string> {
    return `/api/favicons/${base64Url(origin)}`;
  }

  subscribe(listener: (event: ViewerInvalidation) => void): () => void {
    if (typeof EventSource === "undefined") {
      return () => undefined;
    }
    const source = new EventSource("/api/events");
    const handlers: Array<[ViewerInvalidation["type"], EventListener]> = [];
    for (const type of [
      "favicon.updated",
      "library.updated",
      "session.updated",
      "settings.updated",
      "diagnostic.updated",
      "search.updated",
    ] as const) {
      const handler: EventListener = (event): void => {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          return;
        }
        try {
          const parsed = viewerInvalidationSchema.safeParse(JSON.parse(event.data) as unknown);
          if (parsed.success) {
            if (parsed.data.type === "favicon.updated") {
              publishFaviconAvailability(parsed.data.ids, parsed.data.revision);
            }
            listener(parsed.data);
          }
        } catch {
          // A malformed local event is ignored; the periodic reconciliation remains authoritative.
        }
      };
      handlers.push([type, handler]);
      source.addEventListener(type, handler);
    }
    return () => {
      for (const [type, handler] of handlers) {
        source.removeEventListener(type, handler);
      }
      source.close();
    };
  }
}
