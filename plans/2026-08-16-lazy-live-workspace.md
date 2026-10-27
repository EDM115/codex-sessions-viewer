# Lazy Live Workspace and Protocol-Aware Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace eager live archive normalization with a persistent metadata catalog and on-demand cache, then deliver persistent project/subagent navigation, protocol-aware tool rendering, chronological turn work, and reliable minimap jumps.

**Architecture:** A viewer-owned SQLite catalog becomes the source for library counts, folders, topology, and preparation state; the existing normalized tables remain the source for opened conversation payloads and exact cached transcript search. One serialized priority queue materializes visible or opened sessions, while protocol normalization emits stable ordered entries that the desktop workspace renders without losing raw evidence.

**Tech Stack:** Node.js 26, TypeScript 6, Nuxt 4/Nitro, Vue 3, H3, `node:sqlite`, Zod 4, TanStack Vue Virtual, Vitest, Playwright, existing unified/remark rich-text pipeline, and existing `@pierre/diffs` renderer.

**Spec:** `docs/plans/2026-08-16-lazy-live-workspace-design.md`

## Global Constraints

- Codex source data under the selected Codex home is read-only and may be mid-write.
- The server remains loopback-only and all browser APIs remain same-origin.
- Do not enable `retainLiveSources` or retain an archive-wide normalized object graph.
- Visible background preparation has concurrency one; an explicitly opened session takes priority.
- Live search is progressive; archive-wide cold transcript scanning starts only from the explicit user action.
- Static Pagefind remains exact.
- `codex-auto-review` guardian sessions never appear in library counts, folders, routes, or model filters.
- Root conversation counts exclude nested subagents and auxiliary sessions.
- `tsconfig.custom.json` remains limited to non-default entrypoints such as scripts and pure tests; Nuxt-owned app/server imports stay under Nuxt type-checking.
- Do not stage, commit, branch, create worktrees, reset, or perform any destructive Git operation. Replace every commit checkpoint from the generic workflow with a read-only diff/status checkpoint.
- Do not launch the real 576-session indexed Pagefind export. Real-data live smoke and representative fixture export are allowed.

---

### Task 1: Define catalog, project, topology, preparation, and ordered-turn contracts

**Files:**

- Create: `shared/types/library.ts`
- Create: `shared/library/projectIdentity.ts`
- Modify: `shared/types/conversation.ts`
- Modify: `shared/types/repository.ts`
- Modify: `tests/unit/contracts/repository.test.ts`
- Create: `tests/unit/library/projectIdentity.test.ts`

**Interfaces:**

- Produces: `ConversationListItem`, `ConversationProject`, `MaterializationState`, `PreparationResult`, `DeepSearchJob`, and their Zod schemas.
- Produces: `ConversationRepository.listProjects`, `prepareSessions`, `startDeepSearch`, `getDeepSearch`, and `cancelDeepSearch` methods.
- Produces: `ConversationTurn.steeringMessages`, `ConversationTurn.entryOrder`, `ConversationTurn.finalAssistantMessageId`, `TurnEntryReference`, `FileChangeActivity`, and optional tool approval evidence.
- Consumes: existing `ConversationSummary`, `ConversationMessage`, `ConversationActivity`, cursor page, search, and invalidation contracts.

- [x] **Step 1: Write failing contract tests for strict list/project/preparation parsing**

Add representative assertions that reject unknown materialization states and auxiliary list kinds:

```ts
expect(
  conversationListItemSchema.parse({
    summary: summary(),
    kind: "subagent",
    materialization: "cold",
    projectId: "project:codex-sessions-viewer",
    parentThreadId: "parent-1",
    agentPath: "/root/review",
    agentNickname: "Fermat",
    agentDepth: 1,
    childCount: 0,
  }),
).toMatchObject({ kind: "subagent", materialization: "cold" });
expect(() => conversationListItemSchema.parse({ ...validItem, kind: "auxiliary" })).toThrow();
```

- [x] **Step 2: Write failing pure project-identity tests**

Cover Windows path case folding, directory-boundary matching, longest-root selection, Git-origin fallback, cwd fallback, and `No project`:

```ts
expect(
  resolveConversationProject(
    { cwd: "C:\\Work\\repo\\packages\\app", gitOriginUrl: "https://example.test/repo.git" },
    [
      { id: "broad", name: "Work", rootPaths: ["C:\\Work"] },
      { id: "repo", name: "Repo", rootPaths: ["c:\\work\\repo"] },
    ],
  ),
).toMatchObject({ id: "codex:repo", source: "codex", name: "Repo" });
expect(
  resolveConversationProject({ cwd: "C:\\Workshop", gitOriginUrl: null }, [
    { id: "work", name: "Work", rootPaths: ["C:\\Work"] },
  ]).source,
).toBe("cwd");
```

- [x] **Step 3: Run the focused contract tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/contracts/repository.test.ts tests/unit/library/projectIdentity.test.ts`

Expected: failures for missing modules/types and repository methods.

- [x] **Step 4: Implement strict shared contracts and schemas**

Use these public shapes consistently in every later task:

```ts
export type MaterializationState = "cold" | "queued" | "loading" | "ready" | "failed";
export interface ConversationListItem {
  summary: ConversationSummary;
  kind: "root" | "subagent";
  materialization: MaterializationState;
  projectId: string;
  parentThreadId: string | null;
  agentPath: string | null;
  agentNickname: string | null;
  agentDepth: number | null;
  childCount: number;
}
export interface ConversationProject {
  id: string;
  name: string;
  source: "codex" | "git" | "cwd" | "none";
  hint: string | null;
  activeCount: number;
  archivedCount: number;
}
export interface PreparationResult {
  id: string;
  state: MaterializationState;
  error: string | null;
}
export interface TurnEntryReference {
  kind: "message" | "activity";
  id: string;
}
```

Add repository signatures with request options on networked methods:

```ts
listProjects(options?: RepositoryRequestOptions): Promise<ConversationProject[]>;
prepareSessions(ids: string[], options?: RepositoryRequestOptions): Promise<PreparationResult[]>;
startDeepSearch(query: SearchQuery, options?: RepositoryRequestOptions): Promise<DeepSearchJob>;
getDeepSearch(id: string, options?: RepositoryRequestOptions): Promise<DeepSearchJob>;
cancelDeepSearch(id: string, options?: RepositoryRequestOptions): Promise<void>;
```

Extend invalidations with `search.updated`. Add `projectId` and `parentThreadId` filters to `SessionListQuery`; use an explicit root sentinel in query serialization rather than overloading `undefined`.

- [x] **Step 5: Implement project identity without filesystem traversal**

Normalize Windows separators/case for comparison, require a directory boundary after a matched root, select the longest matching root, and derive stable SHA-256-based IDs for Git/cwd fallbacks. Strip `.git` only from display labels, not identity input.

- [x] **Step 6: Run focused tests and inspect the contract diff**

Run: `pnpm exec vitest run --project node tests/unit/contracts/repository.test.ts tests/unit/library/projectIdentity.test.ts`

Expected: all focused tests pass.

Run: `rtk git diff -- shared/types/library.ts shared/library/projectIdentity.ts shared/types/conversation.ts shared/types/repository.ts tests/unit/contracts/repository.test.ts tests/unit/library/projectIdentity.test.ts`

### Task 2: Add the persistent session catalog migration and query store

**Files:**

- Modify: `server/cache/schema.ts`
- Modify: `server/cache/migrations.ts`
- Create: `server/cache/catalogStore.ts`
- Modify: `server/cache/conversationStore.ts`
- Modify: `tests/unit/cache/database.test.ts`
- Create: `tests/unit/cache/catalogStore.test.ts`

**Interfaces:**

- Consumes: Task 1 list/project/materialization contracts.
- Produces: `CatalogSessionInput`, `upsertCatalogSessions`, `seedCatalogFromNormalizedSessions`, `listCatalogSessions`, `listCatalogProjects`, `catalogSession`, `setCatalogMaterialization`, `removeCatalogSource`, and `catalogMaterializedSessionIds`.

- [x] **Step 1: Write a failing migration test for schema version 2**

Create a version-1 in-memory database, insert one normalized session, run migration, and assert the new row is ready:

```ts
expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
expect(database.prepare("SELECT id, materialization_state FROM session_catalog").get()).toEqual({
  id: session.summary.id,
  materialization_state: "ready",
});
```

Also assert auxiliary rows cannot satisfy the public-kind check and invalid materialization states fail SQLite constraints.

- [x] **Step 2: Write failing catalog-store tests**

Cover root-only totals, project/scope pagination at 20, child pagination, auxiliary exclusion, ready-summary overlay, failed-state preservation, source removal, and deterministic `updated_at DESC, id` ordering:

```ts
const page = listCatalogSessions(database, {
  scope: "active",
  projectId: "codex:viewer",
  parentThreadId: "__root__",
  limit: 20,
});
expect(page.items).toHaveLength(20);
expect(page.total).toBe(21);
expect(page.nextCursor).toBe("20");
expect(page.items.every(({ kind }) => kind === "root")).toBe(true);
```

- [x] **Step 3: Run the focused cache tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/cache/database.test.ts tests/unit/cache/catalogStore.test.ts`

Expected: missing version-2 migration and store exports.

- [x] **Step 4: Implement migration 2 and seed existing cache rows**

Create strict columns and indexes for source path, scope/project/root pagination, parent lookup, materialization state, and updated ordering. Store the catalog-list summary JSON separately from normalized `sessions.summary_json` so cold metadata does not masquerade as a complete session.

The migration SQL must end with a seed statement equivalent to:

```sql
INSERT INTO session_catalog (..., session_kind, materialization_state, ...)
SELECT ..., CASE WHEN parent_thread_id IS NULL THEN 'root' ELSE 'subagent' END, 'ready', ...
FROM sessions;
```

- [x] **Step 5: Implement catalog transactions and normalized-summary overlay**

`listCatalogSessions` selects catalog rows, left-joins ready normalized summaries where present, parses every JSON value through Zod, excludes `session_kind = 'auxiliary'`, and computes root totals independently from child totals. State transitions allow `failed -> queued -> loading -> ready` and `ready -> cold` after a source revision change while preserving the last good normalized row.

Update `replaceCachedSession` to mark an existing catalog row ready in the same transaction; do not create a public root row for a guardian source.

- [x] **Step 6: Run focused cache tests and inspect the diff**

Run: `pnpm exec vitest run --project node tests/unit/cache/database.test.ts tests/unit/cache/catalogStore.test.ts tests/unit/cache/conversationStore.test.ts`

Expected: all focused cache tests pass.

Run: `rtk git diff -- server/cache/schema.ts server/cache/migrations.ts server/cache/catalogStore.ts server/cache/conversationStore.ts tests/unit/cache`

### Task 3: Build a byte-bounded metadata catalog from discovery, state, and session prefixes

**Files:**

- Create: `server/ingestion/sessionMetaPrefix.ts`
- Create: `server/live/catalogBuilder.ts`
- Modify: `server/metadata/globalState.ts`
- Modify: `server/live/reconciler.ts`
- Create: `tests/unit/ingestion/sessionMetaPrefix.test.ts`
- Create: `tests/unit/live/catalogBuilder.test.ts`
- Add fixtures: `tests/fixtures/catalog/`

**Interfaces:**

- Consumes: `discoverSources`, session index, global state projects, retained/fresh state snapshots, Task 1 project resolution, and Task 2 catalog writes.
- Produces: `readSessionMetaPrefix(path, maxBytes)`, `classifySessionMeta`, and `refreshLiveCatalog(options): Promise<CatalogRefreshResult>`.

- [x] **Step 1: Write failing bounded-prefix tests**

Create fixtures for root, nested subagent, guardian, missing metadata, incomplete first line, and an oversized first record. Instrument reads:

```ts
const result = await readSessionMetaPrefix(source, 4096, { openFile });
expect(result.bytesRead).toBeLessThanOrEqual(4096);
expect(result.meta?.source).toEqual({ subagent: { other: "guardian" } });
expect(readCalls).toEqual([{ offset: 0, length: 4096 }]);
```

Assert the file is rejected when it changes between the pre/post observations and retried later without consuming partial metadata.

- [x] **Step 2: Write failing catalog-builder tests**

Use a fake discovery result with declared Codex projects and state spawn edges. Assert:

```ts
expect(result.rows.find(({ id }) => id === "guardian")?.kind).toBe("auxiliary");
expect(result.rows.find(({ id }) => id === "child")?.parentThreadId).toBe("parent");
expect(result.rows.find(({ id }) => id === "child")?.agentDepth).toBe(2);
expect(result.projects.find(({ name }) => name === "Viewer")?.activeCount).toBe(1);
expect(normalizeSource).not.toHaveBeenCalled();
```

Cover cycle rejection (`a -> b -> a`), filename-ID fallback, longest project root, stale source removal, and metadata updates that do not normalize cold sources.

- [x] **Step 3: Run focused tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/ingestion/sessionMetaPrefix.test.ts tests/unit/live/catalogBuilder.test.ts`

Expected: missing prefix reader/catalog builder.

- [x] **Step 4: Implement the stable bounded prefix reader**

Use `lstat`/`open`/`read` with a fixed maximum, reject symlinks and non-regular files, compare device/inode/size/mtime/ctime before and after, and split only on ASCII LF. Parse complete JSON records until `session_meta`; never use `readline` and never continue beyond the bound.

- [x] **Step 5: Expose parsed global projects and retained snapshot reads**

Carry `GlobalStateMetadata` through live metadata instead of discarding it after diagnostics. Add a read-only helper for the current retained viewer-owned state snapshot, then refresh the Codex database copy asynchronously after the first catalog transaction.

- [x] **Step 6: Implement source classification and catalog merging**

Classification must follow:

```ts
if (source.subagent?.other === "guardian")
  return { kind: "auxiliary", auxiliarySubtype: "guardian" };
if (source.subagent?.thread_spawn !== undefined) return { kind: "subagent", ...threadSpawn };
return validatedParentThreadId === null ? { kind: "root" } : { kind: "subagent" };
```

Merge priority is rollout `session_meta`, then state thread/spawn edge, then session index, then filename/stat fallback. Build project descriptors from Codex projects plus Git/cwd fallbacks and calculate counts from root rows only.

- [x] **Step 7: Replace reconciler startup's full pass with catalog refresh**

`LiveReconciler.start()` starts watchers, waits for watcher readiness, calls `refreshLiveCatalog`, marks itself started, schedules queued watcher batches, and starts the periodic catalog interval. Remove the startup loop that calls `#updateSource` for every rollout. Keep `#updateSource` private for explicit/hot materialization in Task 4.

- [x] **Step 8: Run focused tests and the existing watcher regressions**

Run: `pnpm exec vitest run --project node tests/unit/ingestion/sessionMetaPrefix.test.ts tests/unit/live/catalogBuilder.test.ts tests/integration/liveReconciliation.test.ts --passWithNoTests`

Expected: catalog tests pass and existing watcher behavior remains green or exposes exact integration assertions that Task 4 must update.

### Task 4: Add the single-concurrency priority materialization queue and lazy repository reads

**Files:**

- Create: `server/live/materializationQueue.ts`
- Modify: `server/live/reconciler.ts`
- Modify: `server/live/viewerRuntime.ts`
- Modify: `server/live/repository.ts`
- Modify: `server/cache/repositoryStore.ts`
- Create: `tests/unit/live/materializationQueue.test.ts`
- Modify: `tests/integration/liveReconciliation.test.ts`
- Create: `tests/integration/liveLazyMaterialization.test.ts`

**Interfaces:**

- Consumes: Task 2 catalog state transitions and existing `#updateSource` normalization/rich-content path.
- Produces: `MaterializationQueue.enqueue(ids, priority, owner?)`, `LiveReconciler.prepareSessions`, `ensureMaterialized`, `cancelOwner`, and repository payload methods that await explicit materialization.

- [x] **Step 1: Write failing queue tests for deduplication, priority, cancellation, and concurrency one**

Use deferred operations and assert exact execution order:

```ts
const visible = queue.enqueue(["visible-a", "visible-b"], "visible");
const opened = queue.enqueue(["opened"], "open");
expect(started).toEqual(["visible-a"]);
release("visible-a");
await tick();
expect(started).toEqual(["visible-a", "opened"]);
expect(maxConcurrent).toBe(1);
```

Enqueue the same ID from visible/open owners and prove one normalization promise serves both. Cancel a deep-search owner and prove already-running work completes while unowned queued IDs are removed.

- [x] **Step 2: Write a failing integration test proving startup performs zero full parses**

Inject a `readJsonl` spy into `LiveViewerRuntime.start`, call initial reconciliation, list the first 20 catalog rows, and assert:

```ts
expect(readJsonl).not.toHaveBeenCalled();
expect(page.items).toHaveLength(20);
await runtime.repository.prepareSessions([page.items[0]!.summary.id]);
expect(readJsonl).toHaveBeenCalledTimes(1);
```

Add a watcher update: a cold source remains cold without a parse; the prepared source reparses once and publishes both library/session invalidations.

- [x] **Step 3: Run focused tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/live/materializationQueue.test.ts tests/integration/liveLazyMaterialization.test.ts`

Expected: missing queue and startup still invokes full reconciliation.

- [x] **Step 4: Implement the queue with owned promises**

Use a map keyed by session ID, two FIFO queues (`open`, then `visible`/`deep-search`), one active worker, and owner reference sets. Never hold normalized sessions after `#updateSource` commits. Transition catalog rows through queued/loading/ready/failed and return one `PreparationResult` per requested ID.

- [x] **Step 5: Implement reconciler preparation and hot/cold watcher behavior**

`prepareSessions` validates catalog IDs and enqueues them. `ensureMaterialized` returns immediately only when catalog and normalized revisions agree; otherwise it enqueues with `open` priority. A changed cold source updates its catalog revision and removes no last-good payload; a changed ready source is queued once as hot work.

Make `close()` cancel queued ownership, wait for the active writer, close watchers, and settle every caller without unhandled rejections.

- [x] **Step 6: Inject materialization into the live repository**

Construct `LiveConversationRepository(database, bus, materializer)`. `listSessions` and `listProjects` are catalog-only. `getSession`, navigator, turns, and inspector call `await ensureMaterialized(id)` before their bounded SQL query. `getTurns` uses the requested target limit and never hydrates the full session.

- [x] **Step 7: Run focused and existing live integration tests**

Run: `pnpm exec vitest run --project node tests/unit/live/materializationQueue.test.ts tests/integration/liveLazyMaterialization.test.ts tests/integration/liveReconciliation.test.ts tests/unit/cache/repositoryStore.test.ts`

Expected: all pass, maximum parse concurrency is one, and startup read count is zero.

### Task 5: Expose catalog/project/preparation and progressive-search APIs with static parity

**Files:**

- Modify: `server/api/_validation.ts`
- Modify: `server/api/sessions/index.get.ts`
- Create: `server/api/projects.get.ts`
- Create: `server/api/sessions/prepare.post.ts`
- Create: `server/api/search/materialize.post.ts`
- Create: `server/api/search/materialize/[id].get.ts`
- Create: `server/api/search/materialize/[id].delete.ts`
- Modify: `server/api/search.get.ts`
- Modify: `server/live/repository.ts`
- Modify: `server/live/invalidationBus.ts`
- Modify: `app/repositories/live.ts`
- Modify: `app/repositories/static.ts`
- Modify: `server/export/writeStaticPayloads.ts`
- Modify: `shared/types/staticPayloads.ts`
- Modify: `tests/unit/ui/repositories.test.ts`
- Modify: `tests/unit/export/staticPayloads.test.ts`
- Create: `tests/integration/progressiveSearch.test.ts`

**Interfaces:**

- Consumes: Task 1 repository contracts and Task 4 queue.
- Produces: loopback endpoints and `DeepSearchJob` lifecycle with SSE `search.updated` invalidations.

- [x] **Step 1: Write failing API/repository tests for 20-row lists, projects, preparation, and static no-ops**

Assert exact client paths and bodies:

```ts
await repository.prepareSessions(["a", "b"]);
expect(requester).toHaveBeenCalledWith(
  "/api/sessions/prepare",
  expect.objectContaining({ method: "POST", body: { ids: ["a", "b"] } }),
);
await expect(staticRepository.prepareSessions(["a"])).resolves.toEqual([
  { id: "a", state: "ready", error: null },
]);
```

Update `RepositoryRequester` options to include method/body while retaining signal. Parse every response/body with strict Zod schemas and cap preparation batches at 20 unique IDs.

- [x] **Step 2: Write a failing progressive-search integration test**

Seed one ready matching session and two cold sessions. Assert ordinary search returns catalog metadata plus exact ready hit without parsing cold sources. Start a deep-search job, release each queued parse, and assert monotonic completed/failed counts and `search.updated` events. Cancel a second job and assert its remaining cold work does not start.

- [x] **Step 3: Run focused tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/ui/repositories.test.ts tests/integration/progressiveSearch.test.ts tests/unit/export/staticPayloads.test.ts`

Expected: missing repository methods/endpoints/static project payloads.

- [x] **Step 4: Implement validated endpoints and requester support**

Use H3 body parsing with schemas such as:

```ts
const prepareBodySchema = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(20) });
const deepSearchBodySchema = searchQuerySchema.omit({ cursor: true, limit: true });
```

Return `400 Validation Error` for malformed payloads, `404` for unknown job/session IDs, and retain current loopback runtime attachment.

- [x] **Step 5: Implement deep-search jobs as queue owners**

Snapshot matching cold root IDs from the selected scope, enqueue with a job owner, update counts after each result, and publish `search.updated` with job ID. Do not retain session payload objects in the job. Cancellation calls `cancelOwner(jobId)` and marks the job cancelled.

- [x] **Step 6: Add static project/topology payloads and no-op preparation**

Write `payloads/projects.json` during export, derive list items as always ready, and make static list filtering honor `projectId`/`parentThreadId`. Pagefind search remains unchanged and exact. Update verifier topology checks later in Task 11.

- [x] **Step 7: Run focused API/repository/search tests**

Run: `pnpm exec vitest run --project node tests/unit/ui/repositories.test.ts tests/integration/progressiveSearch.test.ts tests/unit/export/staticPayloads.test.ts tests/unit/ui/staticRepository.test.ts`

Expected: all pass with no cold parse before explicit deep search.

### Task 6: Move the library into persistent layout state and fix offline zero counts

**Files:**

- Create: `app/composables/useLibraryWorkspace.ts`
- Create: `app/components/library/LibraryWorkspace.vue`
- Modify: `app/layouts/default.vue`
- Modify: `app/pages/index.vue`
- Modify: `app/pages/session/[id].vue`
- Split/modify: `app/components/library/LibraryExplorer.vue`
- Modify: `app/components/library/LibrarySidebar.vue`
- Modify: `app/assets/css/components.css`
- Modify: `tests/unit/ui/library.test.ts`
- Modify: `tests/unit/ui/librarySidebar.test.ts`
- Create: `tests/unit/ui/libraryWorkspace.test.ts`

**Interfaces:**

- Consumes: Task 5 repository methods and list items.
- Produces: shared route-mounted library state, 20-row page loading, stable counts/filters/folder state, and selected-session highlighting.

- [x] **Step 1: Write a failing regression for delayed static initial data**

Mount the workspace with a deferred repository response, navigate the mocked route from `/session/a` to `/`, resolve the payload, and assert counts update without toggling tabs:

```ts
expect(wrapper.get('[role="tab"][data-value="active"]').text()).toContain("0");
resolvePayload({ counts: { active: 513, archived: 63 }, ...page });
await flushPromises();
expect(wrapper.get('[role="tab"][data-value="active"]').text()).toContain("513");
```

Navigate to a session and back and assert the same state object retains loaded items, cursor, expanded folders, query, and scroll offset.

- [x] **Step 2: Write failing layout tests for desktop persistence and narrow overlay**

Desktop: session route renders both `Session library` and `Conversation timeline`; selected row has `aria-current="page"`. Narrow: rail starts hidden, toggle opens it, Escape restores toggle focus, and selecting a session closes the overlay.

- [x] **Step 3: Run UI tests and confirm red failures**

Run: `pnpm exec vitest run --project ui tests/unit/ui/library.test.ts tests/unit/ui/librarySidebar.test.ts tests/unit/ui/libraryWorkspace.test.ts`

Expected: index-only controller unmounts and delayed data remains zero.

- [x] **Step 4: Implement shared library state with latest-wins requests**

Move route query parsing, counts, projects, pages, search hits, runtime status, abort ownership, SSE subscription, and scroll/folder state into `useLibraryWorkspace`. Use `useState`/layout lifetime and apply `useAsyncData` through a watcher:

```ts
watch(
  initial.data,
  (payload) => {
    if (payload !== undefined && requestGeneration === activeGeneration) applyPayload(payload);
  },
  { immediate: true },
);
```

Set list limit to 20. Preserve last-good data while refreshing and show skeletons only for rows/folders without settled content.

- [x] **Step 5: Implement `LibraryWorkspace` in the default layout**

Render the shared rail around `<slot />` only for `/` and `/session/**`; render settings directly. Remove duplicate index-only rail ownership. CSS uses a persistent desktop column and the existing fixed overlay below the narrow breakpoint.

- [x] **Step 6: Run focused UI tests**

Run: `pnpm exec vitest run --project ui tests/unit/ui/library.test.ts tests/unit/ui/librarySidebar.test.ts tests/unit/ui/libraryWorkspace.test.ts`

Expected: counts settle once, route return preserves state, and desktop/narrow contracts pass.

### Task 7: Render project folders, nested subagents, and visibility-driven preparation

**Files:**

- Create: `app/components/library/LibraryProjectTree.vue`
- Create: `app/components/library/LibraryProjectFolder.vue`
- Create: `app/components/library/LibrarySessionTree.vue`
- Modify: `app/components/library/LibrarySessionList.vue`
- Modify: `app/components/library/LibrarySessionItem.vue`
- Modify: `app/components/library/LibrarySidebar.vue`
- Modify: `app/composables/useLibraryWorkspace.ts`
- Modify: `app/assets/css/components.css`
- Create: `tests/unit/ui/libraryProjectTree.test.ts`
- Modify: `tests/e2e/foundation.spec.ts`

**Interfaces:**

- Consumes: Task 1 topology/project fields, Task 5 project/preparation APIs, and Task 6 persistent state.
- Produces: lazy project/child expansion, row preparation observer, recursive breadcrumbs, and progressive-search controls.

- [x] **Step 1: Write failing project-tree tests**

Assert folders render all project counts without loading sessions, expansion requests exactly 20 roots, load-more uses its cursor, child expansion queries `parentThreadId`, and a child never renders at the project root. Include a parent that is itself a child.

- [x] **Step 2: Write failing visibility batching tests**

Stub `IntersectionObserver`, intersect five cold rows twice, flush one microtask, and assert one deduplicated call:

```ts
expect(repository.prepareSessions).toHaveBeenCalledTimes(1);
expect(repository.prepareSessions).toHaveBeenCalledWith(
  ["a", "b", "c", "d", "e"],
  expect.anything(),
);
```

Assert ready rows are skipped, failed rows expose retry, and unmounted rows do not enqueue after observer disconnect.

- [x] **Step 3: Run focused UI tests and confirm red failures**

Run: `pnpm exec vitest run --project ui tests/unit/ui/libraryProjectTree.test.ts tests/unit/ui/libraryWorkspace.test.ts`

Expected: no project tree/observer behavior exists.

- [x] **Step 4: Implement folder and recursive session components**

Use native/button disclosures with `aria-expanded`, stable IDs, keyboard navigation, and per-folder load-more. Show `Preparing…`, `Ready`, or a retry affordance without replacing title/project metadata with zero-count placeholders.

Derive breadcrumbs from loaded ancestor descriptors and add direct child route links. Suppress auxiliary rows defensively even if a malformed API response reaches presentation.

- [x] **Step 5: Implement visibility preparation and progressive search UI**

Batch intersections up to 20 IDs, abort the network request when the workspace is disposed, and refresh only affected catalog rows on `library.updated`. Search copy states exact coverage explicitly and the `Search unloaded conversations` button starts/cancels a deep-search job with progress.

- [x] **Step 6: Add desktop E2E coverage**

Extend the fixture/API so a project has 21 roots, one nested child, and one auxiliary guardian. Assert desktop conversation view keeps the rail, counts exclude the two hidden/nested rows, project pagination is 20, child navigation works, and no preparation request is made for a row that never intersects.

- [x] **Step 7: Run focused UI/E2E tests**

Run: `pnpm exec vitest run --project ui tests/unit/ui/libraryProjectTree.test.ts tests/unit/ui/libraryWorkspace.test.ts`

Run: `pnpm exec playwright test tests/e2e/foundation.spec.ts --grep "project|desktop rail|visible"`

Expected: project, topology, visibility, and persistent-rail scenarios pass.

### Task 8: Normalize chronological turn entries, steering messages, and distinct Markdown reasoning

**Files:**

- Modify: `server/normalization/normalizeSession.ts`
- Modify: `server/normalization/turnAssembler.ts`
- Modify: `server/export/prepareConversation.ts`
- Modify: `server/cache/conversationStore.ts`
- Modify: `server/cache/repositoryStore.ts`
- Modify: `server/cache/searchStore.ts`
- Modify: `server/export/buildPagefind.ts`
- Modify: `tests/unit/normalization/normalizeSession.test.ts`
- Modify: `tests/unit/export/prepareConversation.test.ts`
- Modify: `tests/unit/cache/conversationStore.test.ts`

**Interfaces:**

- Consumes: Task 1 ordered-turn fields.
- Produces: all user messages, `entryOrder`, exact final assistant ID, and one reasoning activity per protocol entry.

- [x] **Step 1: Add a failing fixture with steering, intermediate commentary, and two reasoning entries**

The source order must be prompt, reasoning A, commentary, steering user message, reasoning B, command, final assistant. Use one response-item reasoning payload whose summary array contains two Markdown entries in another turn.

Assert:

```ts
expect(turn.steeringMessages.map(({ sourceMarkdown }) => sourceMarkdown)).toEqual([
  "Please also cover Windows.",
]);
expect(turn.entryOrder.map(({ id }) => id)).toEqual([
  promptId,
  reasoningAId,
  commentaryId,
  steeringId,
  reasoningBId,
  toolId,
  finalId,
]);
expect(turn.finalAssistantMessageId).toBe(finalId);
expect(turn.activities.filter(({ kind }) => kind === "reasoning")).toHaveLength(2);
```

- [x] **Step 2: Add failing rich-content/cache/search assertions**

Assert reasoning `**bold**` produces a rich `<strong>` node, steering messages survive cache round-trip and inspector creation, and FTS/Pagefind include steering/final content once without indexing encrypted content.

- [x] **Step 3: Run focused normalization/content tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/normalization/normalizeSession.test.ts tests/unit/export/prepareConversation.test.ts tests/unit/cache/conversationStore.test.ts`

Expected: only the first user is retained, reasoning array entries merge, and no entry order exists.

- [x] **Step 4: Implement ordered message candidates by raw offset**

Collect every visible user and assistant candidate with `rawEventId`/byte offset. Deduplicate only mirrored `event_msg`/`response_item` views of the same protocol message. Select the first non-bootstrap user as `userMessage`, later user candidates as `steeringMessages`, and the last assistant candidate in raw order as `finalAssistantMessageId`.

For thread-spawn children, prefer the incoming parent `agent_message` assignment and mark leading environment/recommended-plugin scaffolding as hidden protocol evidence rather than visible prompt/search text.

- [x] **Step 5: Emit distinct reasoning candidates and one entry order**

Convert each summary/content array element into its own `ReasoningActivity` with an index-suffixed stable ID. Suppress only adjacent mirrored protocol views with matching source message identity; remove text-key map deduplication. Build `entryOrder` after all activities/messages exist by event byte offset and stable occurrence order.

- [x] **Step 6: Update rich content, cache, inspectors, and search consumers**

Include steering messages anywhere messages are cloned, parsed, stored, indexed, inspected, serialized, or counted. Bump normalization parser version. Keep all SQL reads bounded to requested rows/chunks.

- [x] **Step 7: Run focused tests**

Run: `pnpm exec vitest run --project node tests/unit/normalization/normalizeSession.test.ts tests/unit/export/prepareConversation.test.ts tests/unit/cache/conversationStore.test.ts tests/unit/cache/searchStore.test.ts`

Expected: chronological model, Markdown reasoning, and cache/search round trips pass.

### Task 9: Enrich subagent activity and attach guardian approval evidence

**Files:**

- Create: `server/normalization/guardianEvidence.ts`
- Create: `server/normalization/subagentTopology.ts`
- Modify: `server/normalization/normalizeSession.ts`
- Modify: `server/live/reconciler.ts`
- Modify: `server/export/exportPipeline.ts`
- Create: `tests/unit/normalization/guardianEvidence.test.ts`
- Create: `tests/unit/normalization/subagentTopology.test.ts`
- Modify: `tests/unit/normalization/normalizeSession.test.ts`

**Interfaces:**

- Consumes: catalog parent/kind/agent metadata and Task 8 ordered entries.
- Produces: parsed `GuardianApprovalEvidence`, strict tool matching, enriched subagent activities, and cycle-safe ancestry.

- [x] **Step 1: Write failing guardian parsing/matching tests from observed real shapes**

Use a guardian user message containing `Planned action JSON` and a final assistant JSON result:

```ts
expect(parseGuardianTurn(records)).toMatchObject({
  parentThreadId: "parent",
  outcome: "allow",
  riskLevel: "low",
  rationale: expect.stringContaining("read-only"),
});
expect(matchGuardianEvidence([toolA, toolB], [reviewA])).toEqual(new Map([[toolA.id, reviewA]]));
```

Assert ambiguous same-command candidates remain unassociated, denial is preserved, malformed JSON emits a diagnostic, and encrypted/repeated transcript content never becomes prose.

- [x] **Step 2: Write failing subagent topology/activity tests**

Cover nested parent chains, cycles, started/interacted updates, parent-to-child and child-to-parent messages, agent path/nickname enrichment, and linkable child IDs.

- [x] **Step 3: Run focused tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/normalization/guardianEvidence.test.ts tests/unit/normalization/subagentTopology.test.ts tests/unit/normalization/normalizeSession.test.ts`

Expected: guardian is normalized as a standalone session and agent updates lack reliable child linkage.

- [x] **Step 4: Implement bounded guardian parsing and canonical matching**

Parse only `codex-auto-review` turns from a catalog-classified guardian source. Extract the final result with a strict schema:

```ts
const guardianResultSchema = z.strictObject({
  risk_level: z.string().min(1),
  user_authorization: z.string().min(1).optional(),
  outcome: z.enum(["allow", "deny"]),
  rationale: z.string().min(1),
});
```

Canonicalize reviewed action objects by stable JSON key ordering and normalized command arrays. Match exact action hashes in monotonic order; never use time-only matching. Store unmatched valid results as approval activities and malformed results as diagnostics/raw inspector evidence.

- [x] **Step 5: Enrich parent and child normalization**

Resolve agent path to child ID within one parent catalog scope, merge status/activity records without dropping separate messages, attach approval to the matched tool, and add child links/breadcrumb metadata. Guardian sources are passed as auxiliary inputs when materializing/exporting their parent and never written as `sessions` rows.

- [x] **Step 6: Run focused topology/guardian tests**

Run: `pnpm exec vitest run --project node tests/unit/normalization/guardianEvidence.test.ts tests/unit/normalization/subagentTopology.test.ts tests/unit/normalization/normalizeSession.test.ts`

Expected: guardian exclusion/matching and nested agent enrichment pass.

### Task 10: Derive nested `functions.exec` tools and structured file-change diffs

**Files:**

- Create: `server/normalization/nestedExec.ts`
- Modify: `server/normalization/toolPairing.ts`
- Modify: `server/normalization/normalizeSession.ts`
- Create: `tests/unit/normalization/nestedExec.test.ts`
- Modify: `tests/unit/normalization/toolPairing.test.ts`

**Interfaces:**

- Consumes: raw custom-tool call/output interval, structured `patch_apply_end.changes`, Task 1 `FileChangeActivity`, and Task 9 approval evidence.
- Produces: `deriveNestedExecActivities(call, output, siblingEvents)` with lossless fallback.

- [x] **Step 1: Write failing tests from the two reported envelopes**

Use the exact structural forms: one `tools.apply_patch(patch)` call and one `Promise.all` containing three direct `tools.exec_command({...})` calls whose outputs are separate JSON text blocks.

Assert:

```ts
expect(derived.map(({ kind }) => kind)).toEqual(["tool", "tool", "tool"]);
expect(derived.map((activity) => (activity.kind === "tool" ? activity.input : null))).toEqual([
  expect.objectContaining({ cmd: expect.stringContaining("verifyOutput.test.ts") }),
  expect.objectContaining({ cmd: expect.stringContaining("verify:output") }),
  expect.objectContaining({ cmd: expect.stringContaining("doctor") }),
]);
expect(fileChange.files[0]).toMatchObject({
  change: "update",
  path: expect.stringMatching(/verifyOutput\.ts$/u),
  addedLines: 7,
  removedLines: 1,
});
```

Add create-only, multi-file, move/delete, escaped template/string syntax, unknown dynamic argument, mismatched output count, and incomplete patch evidence. Every incomplete case must return the original outer tool unchanged.

- [x] **Step 2: Run focused tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/normalization/nestedExec.test.ts tests/unit/normalization/toolPairing.test.ts`

Expected: only one raw `tool/exec` activity exists.

- [x] **Step 3: Implement a non-executing structural scanner**

Tokenize identifiers, dots, parentheses, braces, brackets, commas, quoted/template strings, comments, and balanced nesting. Extract only direct `tools.<identifier>(<object-or-string-literal>)` expressions. Decode JSON-compatible object/string literals conservatively; reject computed properties, spreads, variable-only arguments, dynamic template interpolation, and unbalanced input. Do not add `eval`, `Function`, VM execution, or browser parsing.

- [x] **Step 4: Pair nested outputs and patch events losslessly**

Normalize outer output content blocks, discard only the known wrapper status block, parse emitted JSON records in order, and require one output per derived command. Correlate `patch_apply_end` only inside the outer call/output offset interval. Build file diffs/counts from `unified_diff` or created content; preserve absolute source path in raw evidence but display a workspace-relative/basename label.

- [x] **Step 5: Integrate derivation after outer tool pairing**

Replace the visible outer activity only when every nested call/output is accounted for. Preserve outer raw IDs on derived children and inspector records. Attach Task 9 approval evidence to the matching derived command rather than the envelope.

- [x] **Step 6: Run focused nested-tool tests**

Run: `pnpm exec vitest run --project node tests/unit/normalization/nestedExec.test.ts tests/unit/normalization/toolPairing.test.ts tests/unit/normalization/normalizeSession.test.ts`

Expected: three commands render as three activities, patch changes retain diffs, and malformed input stays raw.

### Task 11: Render one chronological `Worked for` disclosure and rich tool/file/agent rows

**Files:**

- Create: `app/components/conversation/ConversationWorkStream.vue`
- Create: `app/components/conversation/ConversationWorkEntry.vue`
- Create: `app/components/conversation/ConversationFileChanges.vue`
- Create: `app/components/conversation/ConversationReasoning.vue`
- Modify: `app/components/conversation/ConversationActivityList.vue`
- Modify: `app/components/conversation/ConversationToolRow.vue`
- Modify: `app/components/conversation/ConversationMessage.vue`
- Modify: `app/components/conversation/ConversationTurn.vue`
- Modify: `app/components/conversation/format.ts`
- Modify: `app/assets/css/components.css`
- Modify: `tests/unit/ui/conversation.test.ts`
- Create: `tests/unit/ui/conversationWorkStream.test.ts`

**Interfaces:**

- Consumes: Task 8 entry order, Task 9 agent/approval data, Task 10 derived command/file activities.
- Produces: one collapsed chronological work disclosure, final-only assistant response, diff drill-down, and chronological copy text.

- [x] **Step 1: Write a failing rendering test for exact order and final-only response**

Mount a turn with prompt, two reasoning blocks, commentary, steering, three commands, agent update, and final response. Assert DOM order by `data-entry-id`, exactly one top-level `Worked for 10m 21s`, one visible response, and intermediate commentary only inside the disclosure.

```ts
expect(wrapper.findAll(".conversation-message--assistant:not([data-work-entry])")).toHaveLength(1);
expect(wrapper.get('details[data-activity-group="worked"] summary').text()).toContain(
  "Worked for 10m 21s",
);
expect(wrapper.text()).not.toContain("Encrypted source retained");
```

- [x] **Step 2: Write failing file/tool/agent interaction tests**

Assert three command children produce three `Ran command` rows; two consecutive file changes produce `Edited 2 files`; expanding a file mounts the existing diff renderer; a created-only group says `Created 2 files`; approval outcome/rationale appear with the command; agent row links to the child route.

- [x] **Step 3: Run focused UI tests and confirm red failures**

Run: `pnpm exec vitest run --project ui tests/unit/ui/conversation.test.ts tests/unit/ui/conversationWorkStream.test.ts`

Expected: reasoning/work are split into separate groups and every assistant message is rendered as a response.

- [x] **Step 4: Build the ordered work-stream projection**

Resolve `entryOrder` IDs against prompt/steering/assistant/activity maps. Remove only the first prompt and `finalAssistantMessageId` from the work list. Missing references render a diagnostic-safe unknown row rather than reordering the rest.

Top-level disclosure is collapsed by default and emits resize anchoring events. Render reasoning with `RichTextRenderer`, steering as `You · steering`, intermediate assistant as `Assistant · progress`, and activity-specific rows in the same sequence.

- [x] **Step 5: Implement tool/file/approval/agent presentation**

Use `Ran command` for `exec_command`, command text as secondary content, and existing status/duration formatting. Group only consecutive file-change entries, calculate group wording from change kinds, and use `DiffBlock.client.vue` for each expanded file. Keep raw JSON under an optional technical-details disclosure rather than as the primary label.

- [x] **Step 6: Update copy-agent-work**

Serialize work entries in chronological order with clear `Reasoning`, `You (steering)`, `Assistant (progress)`, `Ran command`, `Edited file`, and `Agent` prefixes; final response remains separately copyable.

- [x] **Step 7: Run focused UI tests**

Run: `pnpm exec vitest run --project ui tests/unit/ui/conversation.test.ts tests/unit/ui/conversationWorkStream.test.ts tests/unit/content-rendering/richTextRenderer.test.ts`

Expected: exact work order, Markdown reasoning, diffs, approval, agent links, and final-only response pass.

### Task 12: Fix distant minimap targeting and marker-relative tooltip positioning

**Files:**

- Modify: `app/composables/useConversationTimeline.ts`
- Modify: `app/components/conversation/ConversationView.vue`
- Modify: `app/components/conversation/TurnMinimap.vue`
- Modify: `app/composables/useTurnMinimap.ts`
- Modify: `app/assets/css/components.css`
- Modify: `tests/unit/ui/conversationTimeline.test.ts`
- Modify: `tests/unit/ui/useTurnMinimap.test.ts`
- Modify: `tests/e2e/foundation.spec.ts`

**Interfaces:**

- Consumes: existing latest-wins timeline and virtualizer APIs.
- Produces: atomic target-window apply hook, pending/error marker state, virtualizer reset before positioning, and measured preview center.

- [x] **Step 1: Write a failing target-window test with stale measurements**

Start on turns 40–59 with a large scroll offset and cached tall-row measurements, click turn 2 before any manual upward scroll, resolve a five-turn target window, and assert target is rendered/aligned while old rows disappear. Resolve an older competing click afterward and assert it is ignored.

- [x] **Step 2: Write a failing tooltip-center component test**

Mock nav/marker rectangles and scroll, activate a marker at 173 px, and assert the preview style uses its center rather than `50%`. Re-run after scroll/resize and assert the value updates.

- [x] **Step 3: Run focused minimap tests and confirm red failures**

Run: `pnpm exec vitest run --project ui tests/unit/ui/conversationTimeline.test.ts tests/unit/ui/useTurnMinimap.test.ts`

Expected: target applies without virtualizer reset/pending state and tooltip remains fixed at 50%.

- [x] **Step 4: Add an atomic target apply hook and virtualizer reset**

Change `loadTarget` to accept `beforeApply`/`afterApply` callbacks like prepend. In `ConversationView`, capture latest request ownership, reset the virtualizer's measurements and scroll offset immediately before replacing the target window, then `nextTick`, measure, `scrollToIndex`, and settle the exact rendered element. Use limit 5 for live target requests; static repository continues using its indexed payload chunk.

Expose `pendingTurnId` and target error to the minimap. Disable duplicate selection only for that target, keep other markers available for latest-wins replacement, and preserve the prior window on failure.

- [x] **Step 5: Measure marker-relative preview position**

Store nav/scroll refs, compute `markerRect.top - navRect.top + markerRect.height / 2`, and bind `--turn-preview-center`. Recompute after activate/focus, minimap scroll, current-turn changes, and `ResizeObserver`; disconnect on unmount. Replace CSS `inset-block-start: 50%` with the custom property.

- [x] **Step 6: Add a static-browser regression with dynamic rows**

Serve a >40-turn static fixture with one multi-viewport-height turn. From the initial recent chunk, click the distant first-quarter marker without scrolling the conversation, assert the target payload request occurs, target becomes visible, URL updates, marker state clears, and preview center differs for two markers.

- [x] **Step 7: Run focused minimap and E2E tests**

Run: `pnpm exec vitest run --project ui tests/unit/ui/conversationTimeline.test.ts tests/unit/ui/useTurnMinimap.test.ts`

Run: `pnpm exec playwright test tests/e2e/foundation.spec.ts --grep "minimap"`

Expected: distant live/static jumps, races, dynamic measurement, keyboard focus, and tooltip centering pass.

### Task 13: Update static payloads, inspectors, verification, performance probes, and operating documentation

**Files:**

- Modify: `shared/types/staticPayloads.ts`
- Modify: `server/export/writeStaticPayloads.ts`
- Modify: `server/export/verifyOutput.ts`
- Modify: `server/export/serializeMarkdown.ts`
- Modify: `server/cache/repositoryStore.ts`
- Modify: `scripts/doctor.ts`
- Modify: `README.md`
- Modify: `tests/unit/export/staticPayloads.test.ts`
- Modify: `tests/unit/export/verifyOutput.test.ts`
- Modify: `tests/unit/export/serializeMarkdown.test.ts`
- Modify: `tests/performance/repositoryScale.test.ts`
- Create: `tests/performance/liveCatalogStartup.test.ts`
- Modify: `tests/e2e/foundation.spec.ts`

**Interfaces:**

- Consumes: every preceding public schema/behavior.
- Produces: versioned static output, complete inspector/Markdown evidence, doctor catalog reporting, and measurable acceptance guards.

- [x] **Step 1: Write failing output-verifier tests for projects/topology/ordered messages**

Generate a representative static tree and delete/corrupt each new contract in turn: missing `projects.json`, auxiliary in session index, child without parent, cycle, missing steering inspector, entry-order reference to an absent message/activity, and final assistant ID mismatch. Assert the verifier rejects each exact defect.

- [x] **Step 2: Write failing performance probes**

Create 500 fake rollout files with very large transcript tails and small metadata prefixes. Assert catalog startup bytes read remain bounded by metadata cap and `normalizeSession` call count is zero. Intersect/prepare 20 sessions and assert maximum concurrent normalizations is one.

```ts
expect(metrics.normalizedSessions).toBe(0);
expect(metrics.maxBytesReadPerSource).toBeLessThanOrEqual(SESSION_META_PREFIX_LIMIT);
expect(metrics.maxConcurrentMaterializations).toBe(1);
```

- [x] **Step 3: Run focused verifier/performance tests and confirm red failures**

Run: `pnpm exec vitest run --project node tests/unit/export/staticPayloads.test.ts tests/unit/export/verifyOutput.test.ts tests/unit/export/serializeMarkdown.test.ts`

Run: `pnpm exec vitest run --project performance tests/performance/liveCatalogStartup.test.ts tests/performance/repositoryScale.test.ts`

Expected: new topology/ordering contracts and startup metrics are not yet verified.

- [x] **Step 4: Version and verify every generated payload**

Write/validate project descriptors, list topology, steering messages, entry order, final response ID, file-change activities, approval evidence, and child breadcrumbs. Verify one session at a time to retain bounded memory. Require auxiliary absence from public payloads and consistent parent/child edges.

- [x] **Step 5: Update Markdown serialization and inspector coverage**

Serialize prompt, chronological `Worked for` entries, and final response in the same order as UI. Inspector records retain derived-to-outer raw IDs, file diffs, approval records, steering messages, and complete turn evidence without duplicating every raw record into every message.

- [x] **Step 6: Update doctor and README operations**

Doctor reports catalog roots/subagents/auxiliaries, ready/cold/failed counts, retained state snapshot, and normalized payload count separately. README explains lazy startup, visible preparation, progressive search, project folders, guardian exclusion, subagent navigation, per-row retry, and why a deep search can intentionally scan cold sessions.

- [x] **Step 7: Run focused output/performance tests**

Run: `pnpm exec vitest run --project node tests/unit/export/staticPayloads.test.ts tests/unit/export/verifyOutput.test.ts tests/unit/export/serializeMarkdown.test.ts`

Run: `pnpm exec vitest run --project performance tests/performance/liveCatalogStartup.test.ts tests/performance/repositoryScale.test.ts`

Expected: output boundaries and performance invariants pass.

### Task 14: Run full gates and realistic live/static acceptance

**Files:**

- Modify only files implicated by a failing gate; add a focused regression before each correction.
- Update: `THOUGHTS.md` only for new durable, non-obvious evidence discovered during acceptance.

**Interfaces:**

- Consumes: completed implementation.
- Produces: evidence-backed acceptance without staging/committing and without the real indexed archive workload.

- [x] **Step 1: Run source formatting in write mode, then verify**

Run: `pnpm format`

Run: `pnpm format:check`

Expected: formatter completes and check is green. Do not format generated `.output`, `.generated`, or user Codex files.

- [x] **Step 2: Run type and lint gates**

Run: `pnpm typecheck`

Run: `pnpm lint`

Expected: no type errors; lint has no new actionable errors. Keep Nuxt-owned modules out of `tsconfig.custom.json` includes.

- [x] **Step 3: Run focused projects, full unit/integration, and performance suites**

Run: `pnpm test`

Run: `pnpm test:integration`

Run: `pnpm test:performance`

Expected: all tests pass with no unhandled rejections or stuck workers. On the known Windows short-TEMP watcher split, rerun with existing long-form workspace `TEMP`/`TMP` and `--no-file-parallelism` before diagnosing repository code.

- [x] **Step 4: Run full browser acceptance**

Run: `pnpm test:e2e`

Expected: project tree, persistent desktop rail, narrow overlay/focus, progressive search, chronological work, diffs, agent navigation, distant minimap, accessibility, local-only networking, and live invalidation tests pass.

- [x] **Step 5: Run production build**

Run: `pnpm build`

Expected: Nuxt/Nitro production build succeeds. If sandbox `readlink` on the Windows profile fails at final tracing, rerun the exact command elevated before judging source.

- [x] **Step 6: Run representative indexed static export and verify it**

Run: `pnpm export --codex-home tests/fixtures --output .tmp/lazy-workspace-acceptance --offline`

Run: `pnpm verify:output --output .tmp/lazy-workspace-acceptance`

Expected: fixture export and Pagefind verification pass. Do not point this indexed command at the real 576-session Codex home.

- [x] **Step 7: Run a real-data live smoke outside the sandbox when needed**

Run: `pnpm live`

Acceptance observations:

- first page shows project folders/counts without waiting for archive normalization;
- terminal does not announce or perform a full cache build;
- the first folder page has at most 20 root conversations;
- only intersected/opened rows transition cold -> loading -> ready, one at a time;
- opening a cold session shows progress and then the conversation while the desktop rail remains present;
- guardian sessions are absent, subagents are nested, and a real `functions.exec` example renders derived commands/file diffs;
- a distant minimap marker works before manual upward scrolling and its tooltip follows the marker.

Stop the live server cleanly after the smoke. Codex sources remain unchanged.

- [x] **Step 8: Run doctor and inspect the final read-only diff/status**

Run: `pnpm run doctor`

Run: `rtk git status --short --untracked-files=all`

Run: `rtk git diff --stat`

Expected: doctor separates catalog and normalized cache state; all intended changes remain unstaged; no generated acceptance directory or unrelated user file appears in the handoff.

## Plan Self-Review

- Spec coverage: Tasks 1–5 cover the lazy catalog, progressive search, API/static parity, and concurrency; Tasks 6–7 cover counts, desktop workspace, projects, visibility, and nested sessions; Tasks 8–11 cover chronological turns, reasoning, guardian/subagents, nested tools/diffs, and final-only responses; Task 12 covers both minimap defects; Tasks 13–14 cover static output, performance, documentation, and acceptance.
- Placeholder scan: the plan contains no deferred implementation markers, generic test instructions, or undefined neighboring interfaces.
- Type consistency: `ConversationListItem`, `ConversationProject`, `PreparationResult`, `DeepSearchJob`, `TurnEntryReference`, `FileChangeActivity`, and the repository methods are defined in Task 1 and used unchanged later.
- Scope decision: this remains one plan because catalog kind/topology fields, static payload versions, normalization entry order, and the persistent rail cross subsystem boundaries; each numbered task still ends in an independently testable deliverable.
