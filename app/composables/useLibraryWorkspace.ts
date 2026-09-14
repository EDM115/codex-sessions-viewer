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
  sessionDestination(
    id: string,
    turnId?: string,
  ): { path: string; query: Record<string, string>; hash?: string };
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
  const childParents = new Map<string, ConversationListItem>();
  const pageRequests = new Map<LibraryPageState, AbortController>();
  const dirtyPages = new WeakSet<LibraryPageState>();
  let pageGeneration = 0;
  let refreshGeneration = 0;
  let stopped = false;
  let refreshAllPages = false;
  const refreshProjectIds = new Set<string>();
  const refreshParentIds = new Set<string>();
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
    const requestGeneration = pageGeneration;
    const request = new AbortController();
    pageRequests.set(page, request);
    try {
      const result = await reloadPage(
        {
          ...listQuery(append ? (page.nextCursor ?? undefined) : undefined),
          projectId,
          parentThreadId: "__root__",
        },
        append ? 0 : page.items.length,
        request.signal,
      );
      if (request.signal.aborted || requestGeneration !== pageGeneration) {
        return;
      }
      page.items = append ? [...page.items, ...result.items] : result.items;
      page.nextCursor = result.nextCursor;
      page.total = result.total;
      for (const item of result.items) {
        if (childParents.has(item.summary.id)) {
          childParents.set(item.summary.id, item);
        }
      }
      dirtyPages.delete(page);
    } catch (reason) {
      if (!request.signal.aborted && requestGeneration === pageGeneration) {
        page.error = errorMessage(reason);
      }
    } finally {
      if (pageRequests.get(page) === request) {
        page.loading = false;
        pageRequests.delete(page);
      }
    }
  }

  async function loadChildren(parent: ConversationListItem, append = false): Promise<void> {
    childParents.set(parent.summary.id, parent);
    const page = childPages.get(parent.summary.id) ?? reactive(emptyPage());
    childPages.set(parent.summary.id, page);
    if (page.loading || (append && page.nextCursor === null)) {
      return;
    }
    page.loading = true;
    page.error = null;
    const requestGeneration = pageGeneration;
    const request = new AbortController();
    pageRequests.set(page, request);
    try {
      const result = await reloadPage(
        {
          scope: scope.value,
          limit: 20,
          ...(append && page.nextCursor !== null ? { cursor: page.nextCursor } : {}),
          parentThreadId: parent.summary.id,
        },
        append ? 0 : page.items.length,
        request.signal,
      );
      if (request.signal.aborted || requestGeneration !== pageGeneration) {
        return;
      }
      page.items = append ? [...page.items, ...result.items] : result.items;
      page.nextCursor = result.nextCursor;
      page.total = result.total;
      for (const item of result.items) {
        if (childParents.has(item.summary.id)) {
          childParents.set(item.summary.id, item);
        }
      }
      dirtyPages.delete(page);
    } catch (reason) {
      if (!request.signal.aborted && requestGeneration === pageGeneration) {
        page.error = errorMessage(reason);
      }
    } finally {
      if (pageRequests.get(page) === request) {
        page.loading = false;
        pageRequests.delete(page);
      }
    }
  }

  async function toggleProject(projectId: string): Promise<void> {
    const requestGeneration = refreshGeneration;
    const expanded = new Set(expandedProjectIds.value);
    if (expanded.has(projectId)) {
      expanded.delete(projectId);
    } else {
      expanded.add(projectId);
    }
    expandedProjectIds.value = expanded;
    const page = projectPages.get(projectId);
    if (expanded.has(projectId) && (page === undefined || dirtyPages.has(page))) {
      await loadProject(projectId);
    }
    if (expandedProjectIds.value.has(projectId)) {
      await refreshDirtyChildren(requestGeneration);
    }
  }

  async function toggleSession(item: ConversationListItem): Promise<void> {
    const requestGeneration = refreshGeneration;
    const expanded = new Set(expandedSessionIds.value);
    if (expanded.has(item.summary.id)) {
      expanded.delete(item.summary.id);
    } else {
      expanded.add(item.summary.id);
    }
    expandedSessionIds.value = expanded;
    const page = childPages.get(item.summary.id);
    if (expanded.has(item.summary.id) && (page === undefined || dirtyPages.has(page))) {
      await loadChildren(item);
    }
    if (expandedSessionIds.value.has(item.summary.id)) {
      await refreshDirtyChildren(requestGeneration);
    }
  }

  // Refresh the already loaded range so a source update does not discard later pages.
  async function reloadPage(
    pageQuery: SessionListQuery,
    retainedCount: number,
    signal: AbortSignal,
  ) {
    const first = await repository.listSessions(pageQuery, { signal });
    const result = { ...first, items: [...first.items] };
    const cursors = new Set<string>();
    while (
      result.items.length < retainedCount &&
      result.nextCursor !== null &&
      !cursors.has(result.nextCursor)
    ) {
      signal.throwIfAborted();
      cursors.add(result.nextCursor);
      // Each opaque cursor comes from the preceding response.
      // oxlint-disable-next-line no-await-in-loop
      const next = await repository.listSessions(
        { ...pageQuery, cursor: result.nextCursor },
        { signal },
      );
      result.items.push(...next.items);
      result.nextCursor = next.nextCursor;
      result.total = next.total;
    }
    return result;
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

  function cancelPage(page: LibraryPageState): void {
    pageRequests.get(page)?.abort();
    pageRequests.delete(page);
    page.loading = false;
  }

  function markChangedPages(ids: readonly string[]): void {
    for (const id of ids) {
      let known = false;
      for (const [projectId, page] of projectPages) {
        if (page.items.some(({ summary }) => summary.id === id)) {
          known = true;
          refreshProjectIds.add(projectId);
        }
      }
      for (const [parentId, page] of childPages) {
        if (parentId === id || page.items.some(({ summary }) => summary.id === id)) {
          known = true;
          refreshParentIds.add(parentId);
          let ancestor: string | null = parentId;
          const visited = new Set<string>();
          while (ancestor !== null && !visited.has(ancestor)) {
            visited.add(ancestor);
            const currentAncestor = ancestor;
            for (const [projectId, roots] of projectPages) {
              if (roots.items.some(({ summary }) => summary.id === currentAncestor)) {
                refreshProjectIds.add(projectId);
              }
            }
            ancestor = childParents.get(ancestor)?.parentThreadId ?? null;
          }
        }
      }
      // An unseen session may be a new root, moved child or newly discovered parent.
      if (!known) {
        refreshAllPages = true;
      }
    }
  }

  function scheduleRefresh(resetPages = false, changedIds?: readonly string[]): void {
    if (stopped) {
      return;
    }
    refreshGeneration += 1;
    if (timer !== null) {
      clearTimeout(timer);
    }
    controller?.abort();
    if (changedIds === undefined) {
      refreshAllPages = true;
    } else {
      markChangedPages(changedIds);
    }
    for (const [id, page] of projectPages) {
      if (resetPages || refreshAllPages || refreshProjectIds.has(id)) {
        dirtyPages.add(page);
        cancelPage(page);
      }
    }
    for (const [id, page] of childPages) {
      if (resetPages || refreshAllPages || refreshParentIds.has(id)) {
        dirtyPages.add(page);
        cancelPage(page);
      }
    }
    if (resetPages) {
      pageGeneration += 1;
      projectPages.clear();
      childPages.clear();
    }
    timer = setTimeout(() => void refreshExpandedProjects(), query.value.trim() === "" ? 0 : 250);
  }

  async function refreshExpandedProjects(): Promise<void> {
    const requestGeneration = refreshGeneration;
    const previousProjects = projects.value;
    await refresh();
    if (stopped || requestGeneration !== refreshGeneration) {
      return;
    }
    for (const project of projects.value) {
      const previous = previousProjects.find(({ id }) => id === project.id);
      if (
        previous?.activeCount !== project.activeCount ||
        previous?.archivedCount !== project.archivedCount
      ) {
        refreshProjectIds.add(project.id);
        const page = projectPages.get(project.id);
        if (page !== undefined) {
          cancelPage(page);
        }
      }
    }
    if (query.value.trim() === "") {
      const previousRoots = new Map([...projectPages].map(([id, page]) => [id, page.items]));
      const refreshedProjects = [...expandedProjectIds.value].filter(
        (id) => refreshAllPages || refreshProjectIds.has(id) || !projectPages.has(id),
      );
      await Promise.all(refreshedProjects.map((id) => loadProject(id)));
      if (stopped || requestGeneration !== refreshGeneration) {
        return;
      }
      // A root leaving its loaded range may have moved to another project or parent.
      if (
        refreshedProjects.some((id) =>
          previousRoots
            .get(id)
            ?.some(
              (item) =>
                !projectPages.get(id)?.items.some(({ summary }) => summary.id === item.summary.id),
            ),
        )
      ) {
        refreshAllPages = true;
        for (const [id, page] of projectPages) {
          if (!refreshedProjects.includes(id)) {
            dirtyPages.add(page);
            cancelPage(page);
          }
        }
        await Promise.all(
          [...expandedProjectIds.value]
            .filter((id) => !refreshedProjects.includes(id))
            .map((id) => loadProject(id)),
        );
      }
      if (stopped || requestGeneration !== refreshGeneration) {
        return;
      }
      const previousChildren = new Map([...childPages].map(([id, page]) => [id, page.items]));
      const refreshedParents = [...expandedSessionIds.value].filter(
        (id) => refreshAllPages || refreshParentIds.has(id) || !childPages.has(id),
      );
      await refreshChildPages(refreshedParents, requestGeneration);
      if (stopped || requestGeneration !== refreshGeneration) {
        return;
      }
      if (
        refreshedParents.some((id) =>
          previousChildren
            .get(id)
            ?.some(
              (item) =>
                !childPages.get(id)?.items.some(({ summary }) => summary.id === item.summary.id),
            ),
        )
      ) {
        await refreshChildPages(
          [...expandedSessionIds.value].filter((id) => !refreshedParents.includes(id)),
          requestGeneration,
        );
        for (const [id, page] of childPages) {
          if (!expandedSessionIds.value.has(id)) {
            dirtyPages.add(page);
          }
        }
      }
    }
    if (stopped || requestGeneration !== refreshGeneration) {
      return;
    }
    refreshAllPages = false;
    refreshProjectIds.clear();
    refreshParentIds.clear();
  }

  function parentIsVisible(parent: ConversationListItem): boolean {
    const visited = new Set<string>();
    let current = parent;
    while (current.parentThreadId !== null) {
      if (visited.has(current.summary.id)) {
        return false;
      }
      visited.add(current.summary.id);
      const ancestorId = current.parentThreadId;
      const currentId = current.summary.id;
      if (
        !expandedSessionIds.value.has(ancestorId) ||
        !childPages.get(ancestorId)?.items.some(({ summary }) => summary.id === currentId)
      ) {
        return false;
      }
      const ancestor = childParents.get(ancestorId);
      if (ancestor === undefined) {
        return false;
      }
      current = ancestor;
    }
    return (
      projectPages.size === 0 ||
      [...expandedProjectIds.value].some((projectId) =>
        projectPages.get(projectId)?.items.some(({ summary }) => summary.id === current.summary.id),
      )
    );
  }

  async function refreshDirtyChildren(requestGeneration: number): Promise<void> {
    await refreshChildPages(
      [...expandedSessionIds.value].filter((id) => {
        const page = childPages.get(id);
        return page !== undefined && dirtyPages.has(page);
      }),
      requestGeneration,
    );
  }

  async function refreshChildPages(ids: string[], requestGeneration: number): Promise<void> {
    const pending = new Set(ids);
    while (pending.size > 0) {
      if (stopped || requestGeneration !== refreshGeneration) {
        return;
      }
      const parents = [...pending].filter(
        (id) => !pending.has(childParents.get(id)?.parentThreadId ?? ""),
      );
      if (parents.length === 0) {
        return;
      }
      // A nested page is refreshed only after its containing page has settled.
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all(
        parents.map(async (id) => {
          pending.delete(id);
          const parent = childParents.get(id);
          if (parent === undefined) {
            return;
          }
          if (!parentIsVisible(parent)) {
            const page = childPages.get(id);
            if (page !== undefined) {
              dirtyPages.add(page);
            }
            return;
          }
          await loadChildren(parent);
        }),
      );
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

  function sessionDestination(id: string, turnId?: string) {
    const navigationQuery: Record<string, string> = {};
    for (const name of ["scope", "q", "model", "cwd", "tool", "media"]) {
      const value = stringQuery(name);
      if (value !== "") {
        navigationQuery[name] = value;
      }
    }
    if (turnId !== undefined) {
      navigationQuery["turn"] = turnId;
    }
    return {
      path: `/session/${encodeURIComponent(id)}`,
      query: navigationQuery,
      ...(turnId === undefined ? {} : { hash: `#turn-${encodeURIComponent(turnId)}` }),
    };
  }

  watch([scope, query, model, cwd, tool, hasMedia], () => scheduleRefresh(true));

  function start(): void {
    stopped = false;
    unsubscribe = repository.subscribe((event) => {
      if (event.type === "library.updated") {
        if (event.ids.length > 0) {
          scheduleRefresh(false, event.ids);
        }
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
    stopped = true;
    refreshGeneration += 1;
    pageGeneration += 1;
    for (const page of pageRequests.keys()) {
      cancelPage(page);
    }
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
    sessionDestination,
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
