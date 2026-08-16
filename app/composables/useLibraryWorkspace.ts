import {
  computed,
  inject,
  nextTick,
  provide,
  reactive,
  ref,
  watch,
  type InjectionKey,
  type Ref,
} from "vue";

import type { ConversationScope } from "#shared/types/conversation.ts";
import type {
  ConversationListItem,
  ConversationProject,
  DeepSearchJob,
} from "#shared/types/library.ts";
import {
  viewerRuntimeStatusSchema,
  type ConversationRepository,
  type RepositoryMode,
  type RepositoryRequestOptions,
  type SearchHit,
  type SearchQuery,
  type SessionListQuery,
  type ViewerRuntimeStatus,
} from "#shared/types/repository.ts";

import { createConversationRepository } from "../repositories/index.ts";
import type { RepositoryRequester } from "../repositories/live.ts";

export interface LibraryPayload {
  counts: Record<ConversationScope, number>;
  hits: SearchHit[];
  items: ConversationListItem[];
  nextCursor: string | null;
  projects: ConversationProject[];
  runtimeStatus: ViewerRuntimeStatus;
  total: number;
}

export interface LibraryPageState {
  error: string | null;
  items: ConversationListItem[];
  loading: boolean;
  nextCursor: string | null;
  total: number;
}

export interface LibraryWorkspaceState {
  closeSidebar(): Promise<void>;
  counts: Record<ConversationScope, number>;
  cwd: Readonly<Ref<string>>;
  deepSearchJob: Ref<DeepSearchJob | null>;
  error: Ref<string | null>;
  expandedProjectIds: Ref<Set<string>>;
  expandedSessionIds: Ref<Set<string>>;
  hasMedia: Readonly<Ref<boolean>>;
  hasSettledContent: Readonly<Ref<boolean>>;
  hits: Ref<SearchHit[]>;
  hydrate(payload: LibraryPayload): void;
  items: Ref<ConversationListItem[]>;
  childPages: Map<string, LibraryPageState>;
  loadPayload(options?: RepositoryRequestOptions, cursor?: string): Promise<LibraryPayload>;
  loading: Ref<boolean>;
  mode: RepositoryMode;
  model: Readonly<Ref<string>>;
  nextCursor: Ref<string | null>;
  projects: Ref<ConversationProject[]>;
  projectPages: Map<string, LibraryPageState>;
  query: Readonly<Ref<string>>;
  refresh(append?: boolean): Promise<void>;
  loadChildren(parent: ConversationListItem, append?: boolean): Promise<void>;
  loadProject(projectId: string, append?: boolean): Promise<void>;
  observeSession(element: Element, item: ConversationListItem): () => void;
  repository: ConversationRepository;
  runtimeStatus: Ref<ViewerRuntimeStatus>;
  scope: Readonly<Ref<ConversationScope>>;
  searchExactTurns: boolean;
  selectedId: Readonly<Ref<string | null>>;
  settledTotal: Ref<number>;
  sidebarOpen: Ref<boolean>;
  start(): void;
  startDeepSearch(): Promise<void>;
  stop(): void;
  toggleProject(projectId: string): Promise<void>;
  toggleSession(item: ConversationListItem): Promise<void>;
  cancelDeepSearch(): Promise<void>;
  tool: Readonly<Ref<string>>;
  updateQuery(name: string, value: string | boolean): void;
  retryPreparation(id: string): Promise<void>;
}

const libraryWorkspaceKey: InjectionKey<LibraryWorkspaceState> = Symbol("library-workspace");

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The local session source could not be read.";
}

export function createLibraryWorkspace(): LibraryWorkspaceState {
  const route = useRoute();
  const router = useRouter();
  const runtimeConfig = useRuntimeConfig();
  const requestFetch = useRequestFetch() as unknown as (
    path: string,
    options: {
      body?: unknown;
      method?: "GET" | "POST" | "DELETE";
      signal?: AbortSignal;
    },
  ) => Promise<unknown>;
  const mode: RepositoryMode = runtimeConfig.public.viewerMode === "static" ? "static" : "live";
  const searchExactTurns = mode === "live" || runtimeConfig.public.pagefindEnabled;
  const requester: RepositoryRequester = (path, options = {}) =>
    requestFetch(path, {
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  const repository = createConversationRepository(mode, requester);

  function stringQuery(name: string): string {
    const value = route.query[name];
    return typeof value === "string" ? value : "";
  }

  const scope = computed<ConversationScope>(() =>
    route.query.scope === "archived" ? "archived" : "active",
  );
  const query = computed(() => stringQuery("q"));
  const model = computed(() => stringQuery("model"));
  const cwd = computed(() => stringQuery("cwd"));
  const tool = computed(() => stringQuery("tool"));
  const hasMedia = computed(() => route.query.media === "1");
  const selectedId = computed(() => {
    if (!route.path.startsWith("/session/")) {
      return null;
    }
    const encoded = route.path.slice("/session/".length).split("/")[0];
    return encoded === undefined || encoded === "" ? null : decodeURIComponent(encoded);
  });

  function listQuery(cursor?: string): SessionListQuery {
    return {
      scope: scope.value,
      limit: 20,
      parentThreadId: "__root__",
      ...(cursor === undefined ? {} : { cursor }),
      ...(query.value.trim() === "" ? {} : { query: query.value.trim() }),
      ...(model.value === "" ? {} : { model: model.value }),
      ...(cwd.value === "" ? {} : { cwd: cwd.value }),
      ...(tool.value === "" ? {} : { tool: tool.value }),
      ...(hasMedia.value ? { hasMedia: true } : {}),
    };
  }

  function searchQuery(cursor?: string): SearchQuery {
    return { ...listQuery(cursor), query: query.value.trim() };
  }

  async function loadPayload(
    options: RepositoryRequestOptions = {},
    cursor?: string,
  ): Promise<LibraryPayload> {
    const searching = query.value.trim() !== "";
    const [projects, nextRuntimeStatus] = await Promise.all([
      repository.listProjects(options),
      mode === "live"
        ? requester("/api/status", options).then((value) => viewerRuntimeStatusSchema.parse(value))
        : Promise.resolve<ViewerRuntimeStatus>({ state: "ready", message: null }),
    ]);
    const nextCounts = projects.reduce<Record<ConversationScope, number>>(
      (totals, project) => ({
        active: totals.active + project.activeCount,
        archived: totals.archived + project.archivedCount,
      }),
      { active: 0, archived: 0 },
    );
    const result = searching
      ? searchExactTurns
        ? await repository.search(searchQuery(cursor), options)
        : await repository.listSessions(listQuery(cursor), options)
      : { items: [], nextCursor: null, total: nextCounts[scope.value] };
    return {
      counts: nextCounts,
      hits: searching && searchExactTurns ? (result.items as SearchHit[]) : [],
      items: searching && searchExactTurns ? [] : (result.items as ConversationListItem[]),
      nextCursor: result.nextCursor,
      projects,
      runtimeStatus: nextRuntimeStatus,
      total: result.total,
    };
  }

  const counts = reactive<Record<ConversationScope, number>>({ active: 0, archived: 0 });
  const projects = ref<ConversationProject[]>([]);
  const items = ref<ConversationListItem[]>([]);
  const hits = ref<SearchHit[]>([]);
  const settledTotal = ref(0);
  const nextCursor = ref<string | null>(null);
  const runtimeStatus = ref<ViewerRuntimeStatus>(
    mode === "live" ? { state: "preparing", message: null } : { state: "ready", message: null },
  );
  const loading = ref(true);
  const error = ref<string | null>(null);
  const sidebarOpen = ref(false);
  const deepSearchJob = ref<DeepSearchJob | null>(null);
  const expandedProjectIds = ref(new Set<string>());
  const expandedSessionIds = ref(new Set<string>());
  const projectPages = reactive(new Map<string, LibraryPageState>());
  const childPages = reactive(new Map<string, LibraryPageState>());
  const hasSettledContent = computed(
    () => projects.value.length > 0 || items.value.length > 0 || hits.value.length > 0,
  );
  let initialized = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let readinessTimer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let unsubscribe: () => void = () => undefined;
  let generation = 0;
  let preparationObserver: IntersectionObserver | null = null;
  let preparationController: AbortController | null = null;
  let preparationScheduled = false;
  const observedSessions = new WeakMap<Element, string>();
  const queuedPreparation = new Set<string>();

  function hydrate(payload: LibraryPayload, append = false): void {
    initialized = true;
    counts.active = payload.counts.active;
    counts.archived = payload.counts.archived;
    projects.value = payload.projects;
    items.value = append ? [...items.value, ...payload.items] : payload.items;
    hits.value = append ? [...hits.value, ...payload.hits] : payload.hits;
    nextCursor.value = payload.nextCursor;
    runtimeStatus.value = payload.runtimeStatus;
    settledTotal.value = payload.total;
    loading.value = false;
    error.value =
      payload.runtimeStatus.state === "error"
        ? (payload.runtimeStatus.message ?? "The local session catalog could not be loaded.")
        : null;
  }

  async function refresh(append = false): Promise<void> {
    controller?.abort();
    const requestController = new AbortController();
    const requestGeneration = ++generation;
    controller = requestController;
    loading.value = true;
    error.value = null;
    try {
      const payload = await loadPayload(
        { signal: requestController.signal },
        append ? (nextCursor.value ?? undefined) : undefined,
      );
      if (!requestController.signal.aborted && requestGeneration === generation) {
        hydrate(payload, append);
      }
    } catch (reason) {
      if (
        !(reason instanceof Error && reason.name === "AbortError") &&
        requestGeneration === generation
      ) {
        error.value = errorMessage(reason);
      }
    } finally {
      if (controller === requestController) {
        loading.value = false;
        controller = null;
      }
    }
  }

  function emptyPage(): LibraryPageState {
    return { error: null, items: [], loading: false, nextCursor: null, total: 0 };
  }

  async function loadProject(projectId: string, append = false): Promise<void> {
    const page = projectPages.get(projectId) ?? reactive(emptyPage());
    projectPages.set(projectId, page);
    if (page.loading || (append && page.nextCursor === null)) {
      return;
    }
    page.loading = true;
    page.error = null;
    try {
      const result = await repository.listSessions({
        ...listQuery(append ? (page.nextCursor ?? undefined) : undefined),
        projectId,
        parentThreadId: "__root__",
      });
      page.items = append ? [...page.items, ...result.items] : result.items;
      page.nextCursor = result.nextCursor;
      page.total = result.total;
    } catch (reason) {
      page.error = errorMessage(reason);
    } finally {
      page.loading = false;
    }
  }

  async function loadChildren(parent: ConversationListItem, append = false): Promise<void> {
    const page = childPages.get(parent.summary.id) ?? reactive(emptyPage());
    childPages.set(parent.summary.id, page);
    if (page.loading || (append && page.nextCursor === null)) {
      return;
    }
    page.loading = true;
    page.error = null;
    try {
      const result = await repository.listSessions({
        ...listQuery(append ? (page.nextCursor ?? undefined) : undefined),
        projectId: parent.projectId,
        parentThreadId: parent.summary.id,
      });
      page.items = append ? [...page.items, ...result.items] : result.items;
      page.nextCursor = result.nextCursor;
      page.total = result.total;
    } catch (reason) {
      page.error = errorMessage(reason);
    } finally {
      page.loading = false;
    }
  }

  async function toggleProject(projectId: string): Promise<void> {
    const expanded = new Set(expandedProjectIds.value);
    if (expanded.has(projectId)) {
      expanded.delete(projectId);
    } else {
      expanded.add(projectId);
      await loadProject(projectId);
    }
    expandedProjectIds.value = expanded;
  }

  async function toggleSession(item: ConversationListItem): Promise<void> {
    const expanded = new Set(expandedSessionIds.value);
    if (expanded.has(item.summary.id)) {
      expanded.delete(item.summary.id);
    } else {
      expanded.add(item.summary.id);
      await loadChildren(item);
    }
    expandedSessionIds.value = expanded;
  }

  function updateMaterialization(id: string, state: ConversationListItem["materialization"]): void {
    const collections = [items.value, ...projectPages.values(), ...childPages.values()].map(
      (collection) => (Array.isArray(collection) ? collection : collection.items),
    );
    for (const collection of collections) {
      const item = collection.find(({ summary }) => summary.id === id);
      if (item !== undefined) {
        item.materialization = state;
      }
    }
  }

  async function flushPreparation(): Promise<void> {
    preparationScheduled = false;
    const ids = [...queuedPreparation].slice(0, 20);
    ids.forEach((id) => queuedPreparation.delete(id));
    if (ids.length === 0) {
      return;
    }
    preparationController ??= new AbortController();
    ids.forEach((id) => updateMaterialization(id, "queued"));
    try {
      const results = await repository.prepareSessions(ids, {
        signal: preparationController.signal,
      });
      results.forEach(({ id, state }) => updateMaterialization(id, state));
    } catch (reason) {
      if (!(reason instanceof Error && reason.name === "AbortError")) {
        ids.forEach((id) => updateMaterialization(id, "failed"));
      }
    }
    if (queuedPreparation.size > 0 && !preparationScheduled) {
      preparationScheduled = true;
      queueMicrotask(() => void flushPreparation());
    }
  }

  function ensurePreparationObserver(): IntersectionObserver | null {
    if (preparationObserver === null && typeof IntersectionObserver !== "undefined") {
      preparationObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const id = observedSessions.get(entry.target);
          if (id !== undefined) {
            queuedPreparation.add(id);
            preparationObserver?.unobserve(entry.target);
          }
        }
        if (queuedPreparation.size > 0 && !preparationScheduled) {
          preparationScheduled = true;
          queueMicrotask(() => void flushPreparation());
        }
      });
    }
    return preparationObserver;
  }

  function observeSession(element: Element, item: ConversationListItem): () => void {
    if (item.materialization === "ready") {
      return () => undefined;
    }
    observedSessions.set(element, item.summary.id);
    ensurePreparationObserver()?.observe(element);
    return () => preparationObserver?.unobserve(element);
  }

  async function retryPreparation(id: string): Promise<void> {
    queuedPreparation.add(id);
    await flushPreparation();
  }

  async function startDeepSearch(): Promise<void> {
    if (query.value.trim() === "") {
      return;
    }
    deepSearchJob.value = await repository.startDeepSearch(searchQuery());
  }

  async function cancelDeepSearch(): Promise<void> {
    const job = deepSearchJob.value;
    if (job === null) {
      return;
    }
    await repository.cancelDeepSearch(job.id);
    deepSearchJob.value = { ...job, state: "cancelled", updatedAt: new Date().toISOString() };
  }

  async function closeSidebar(): Promise<void> {
    sidebarOpen.value = false;
    await nextTick();
    document.querySelector<HTMLButtonElement>(".library-workbench__opener button")?.focus();
  }

  async function pollReadiness(): Promise<void> {
    if (mode !== "live" || runtimeStatus.value.state !== "preparing") {
      return;
    }
    try {
      runtimeStatus.value = viewerRuntimeStatusSchema.parse(await requester("/api/status"));
      if (runtimeStatus.value.state === "ready") {
        await refresh();
        return;
      }
      if (runtimeStatus.value.state === "error") {
        error.value =
          runtimeStatus.value.message ?? "The local session catalog could not be loaded.";
        return;
      }
    } catch (reason) {
      error.value = errorMessage(reason);
      return;
    }
    readinessTimer = setTimeout(() => void pollReadiness(), 750);
  }

  function scheduleRefresh(): void {
    if (timer !== null) {
      clearTimeout(timer);
    }
    controller?.abort();
    projectPages.clear();
    childPages.clear();
    timer = setTimeout(() => void refreshExpandedProjects(), query.value.trim() === "" ? 0 : 250);
  }

  async function refreshExpandedProjects(): Promise<void> {
    await refresh();
    if (query.value.trim() === "") {
      await Promise.all([...expandedProjectIds.value].map((id) => loadProject(id)));
    }
  }

  function updateQuery(name: string, value: string | boolean): void {
    const next = { ...route.query };
    if (value === "" || value === false || (name === "scope" && value === "active")) {
      delete next[name];
    } else {
      next[name] = typeof value === "boolean" ? "1" : value;
    }
    void router.replace({ query: next });
  }

  watch([scope, query, model, cwd, tool, hasMedia], scheduleRefresh);

  function start(): void {
    unsubscribe = repository.subscribe((event) => {
      if (event.type === "library.updated") {
        scheduleRefresh();
      } else if (
        event.type === "search.updated" &&
        deepSearchJob.value !== null &&
        event.ids.includes(deepSearchJob.value.id)
      ) {
        void repository.getDeepSearch(deepSearchJob.value.id).then((job) => {
          deepSearchJob.value = job;
          if (job.state === "completed") {
            scheduleRefresh();
          }
          return undefined;
        });
      }
    });
    if (!initialized || mode === "live") {
      void refresh();
    }
    void pollReadiness();
  }

  function stop(): void {
    unsubscribe();
    controller?.abort();
    preparationController?.abort();
    preparationObserver?.disconnect();
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (readinessTimer !== null) {
      clearTimeout(readinessTimer);
    }
  }

  return {
    closeSidebar,
    childPages,
    cancelDeepSearch,
    counts,
    cwd,
    deepSearchJob,
    error,
    expandedProjectIds,
    expandedSessionIds,
    hasMedia,
    hasSettledContent,
    hits,
    hydrate,
    items,
    loadPayload,
    loading,
    loadChildren,
    loadProject,
    mode,
    model,
    nextCursor,
    projects,
    projectPages,
    query,
    refresh,
    repository,
    observeSession,
    runtimeStatus,
    scope,
    searchExactTurns,
    selectedId,
    settledTotal,
    sidebarOpen,
    start,
    startDeepSearch,
    stop,
    toggleProject,
    toggleSession,
    tool,
    updateQuery,
    retryPreparation,
  };
}

export function provideLibraryWorkspace(workspace: LibraryWorkspaceState): void {
  provide(libraryWorkspaceKey, workspace);
}

export function useLibraryWorkspace(): LibraryWorkspaceState {
  const workspace = inject(libraryWorkspaceKey, null);
  if (workspace === null) {
    throw new Error("Library workspace is unavailable outside the default library layout.");
  }
  return workspace;
}

export function useOptionalLibraryWorkspace(): LibraryWorkspaceState | null {
  return inject(libraryWorkspaceKey, null);
}
