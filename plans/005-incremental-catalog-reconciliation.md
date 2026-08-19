# Plan 005: Reconcile and invalidate only changed catalog state

> **Executor instructions**: Preserve the revision compare-and-commit from plan 003 and duplicate winner policy from plan 004. Add no-op and targeted-change tests before optimizing. Update only plan 005's status row after all gates and performance assertions pass.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- server/live/reconciler.ts server/live/catalogBuilder.ts server/cache/catalogStore.ts server/ingestion/watchSources.ts app/composables/useLibraryWorkspace.ts tests/integration/live/runtime.test.ts tests/unit/live/catalogBuilder.test.ts tests/performance/liveCatalogStartup.test.ts tests/unit/ui/library.test.ts  
> If plans 003 or 004 are not DONE, stop; this plan depends on their final interfaces.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/003-fence-materialization-revisions.md, plans/004-unify-duplicate-source-selection.md
- **Category**: perf, tech-debt
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

Every 30-second pass currently rediscovers all sources, reloads metadata, reads every prefix, upserts the full catalog, and publishes every row ID. Watch batches already contain exact paths and source kinds, but #processBatch discards them and performs the same full pass. With 642 currently discovered rollouts, an unchanged pass reads roughly 2.5 MiB of prefixes before metadata/SQLite/SSE/browser work, and each broad library.updated clears UI page caches. The intended architecture is compact changed-ID invalidation with a bounded full-scan fallback.

## Current state

```ts
// server/live/reconciler.ts:53,585-613
const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;
const discovery = await discoverSources(this.#codexHome);
const metadata = await loadMetadata(discovery, this.#cacheDir, freshStateSnapshot);
const refreshed = await refreshLiveCatalog({ ... });
this.#publish({
  type: "library.updated",
  ids: [...refreshed.rows.map(({ summary }) => summary.id), ...refreshed.removedIds],
  revision: this.#nextRevision(),
});
```

```ts
// server/live/reconciler.ts:640-643
async #processBatch(batch: SourceWatchBatch): Promise<void> {
  void batch;
  await this.#reconcileAll(true);
}
```

```ts
// app/composables/useLibraryWorkspace.ts:466-473
function scheduleRefresh(): void {
  controller?.abort();
  projectPages.clear();
  childPages.clear();
  timer = setTimeout(() => void refreshExpandedProjects(), ...);
}
```

Repository conventions: SourceWatchBatch distinguishes rollout, global-state, session-index, state-database, and state-wal changes; path keys are case-insensitive on Windows; catalog prefixes are capped at 4096 bytes; visible materialization remains serialized; SSE sends IDs/revisions, never transcripts.

## Commands you will need

| Purpose          | Command                                                                                       | Expected on success                              |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Catalog units    | pnpm exec vitest run --project node tests/unit/live/catalogBuilder.test.ts                    | Exit 0                                           |
| Live integration | pnpm exec vitest run --project node tests/integration/live/runtime.test.ts                    | Exit 0                                           |
| UI invalidation  | pnpm exec vitest run tests/unit/ui/library.test.ts                                            | Exit 0                                           |
| Scale            | pnpm test:performance                                                                         | Exit 0; unchanged and one-change assertions pass |
| Full gates       | pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration | Every command exits 0                            |

## Scope

**In scope**: reconciler batching/full-scan fallback; catalog-builder diff result; catalog-store changed-only writes; watcher change consumption if type support is needed; UI handling of targeted invalidations; named tests.  
**Out of scope**: removing periodic recovery entirely; retaining normalized live-source graphs; disabling metadata refresh; publishing transcripts over SSE; changing repository API payloads unnecessarily; broad LiveReconciler class split; full archive export.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit operator authorization. If later authorized, use a message such as perf(live): reconcile changed catalog rows only.

## Steps

### Step 1: Add no-op and one-change characterization tests

At 500-source scale, run an initial refresh then an unchanged refresh. Instrument readPrefix, catalog write statements or returned changed IDs, bus events, and UI requester calls. Assert the second pass reads no unchanged prefixes beyond cheap file observations, writes no catalog rows, publishes no library.updated, and causes no browser page-cache refresh. Then change one rollout and assert exactly that session is re-read/upserted/published; removal emits exactly the removed ID.  
**Verify**: focused catalog/live/performance tests fail against df97571 for broad reads/writes/events.

### Step 2: Make CatalogRefreshResult report semantic changes

Add changedIds separately from rows and removedIds. Compare candidate source revision plus mutable metadata/topology fields against existing catalog records before writing. Upsert only rows whose stored representation changes; preserve ready normalized metrics when source revision is unchanged. Return all rows only where callers need a complete view, but never use all rows as an invalidation list. Ensure duplicate-winner changes from plan 004 count as source changes.  
**Verify**: catalogBuilder tests prove unchanged refresh changedIds=[], same-revision metadata change returns only affected IDs, source revision change demotes/requeues correctly, topology changes include both affected parent/child IDs, and removals are explicit.

### Step 3: Consume watcher batch details

For rollout add/change/remove batches, construct a targeted refresh set from normalized paths and scopes. Use existing catalog/source manifest observations to skip unchanged content-identical touches. For metadata changes, reload only the affected metadata source when safe; because global state/state snapshot can affect many rows, a full catalog comparison is acceptable but must still write/publish only semantic differences. Preserve a full discovery/comparison for startup, periodic recovery, watcher ready, and watcher errors.  
**Verify**: runtime tests inject rollout-only and metadata-only SourceWatchBatch values and assert the correct discovery/metadata/prefix calls and changed IDs.

### Step 4: Skip unchanged prefix reads during full recovery

During periodic/full discovery, compare lstat identity/size/mtime against catalog/source-manifest observations. Read a prefix only for added or observably changed paths; preserve stable-read/hash verification where same-size/mtime ambiguity exists according to current source-manifest rules. Never trust mtime alone to mark normalized content ready.  
**Verify**: performance test with 500 unchanged rollouts reports zero prefix reads after baseline; a same-size content change that the manifest detects still refreshes; changed-source reads remain bounded and concurrency ≤32.

### Step 5: Publish and refresh narrowly

Publish library.updated only when changedIds or removedIds is nonempty and include only those IDs. Keep session.updated for committed hot-session content changes. In the browser, avoid clearing every project/child page when event IDs cannot affect them; at minimum, an empty/unrelated event must be a no-op. Preserve query/search correctness by falling back to a full refresh when current filters make targeted patching unsafe.  
**Verify**: UI tests prove empty/unrelated invalidations do not call the requester, an affected visible item refreshes correctly, removal disappears, and project counts remain correct after metadata changes.

### Step 6: Run performance and full gates

Record before/after values from the 500-source fixture in the test description or maintenance comment, not in THOUGHTS.  
**Verify**: pnpm test:performance; pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration → all exit 0.

## Test plan

- Initial startup still catalogs 500 sources from bounded prefixes.
- Unchanged periodic pass: zero prefix reads, zero catalog writes, zero SSE invalidations, zero UI refetch.
- One changed rollout: one prefix/upsert/ID invalidation; hot session rematerializes behind plan 003's revision fence.
- Content-identical touch: stable verification updates only lightweight manifest observation and does not invalidate.
- Removed/added source and duplicate-winner promotion: correct selected ID/path and invalidation.
- Global state pin/section/project and state snapshot topology changes: only semantically affected IDs emitted.
- Watcher error/overflow and periodic recovery still perform safe full comparison.

## Done criteria

- [ ] Watcher rollout batches no longer discard path/source/kind.
- [ ] Full recovery skips prefix reads for observably unchanged sources.
- [ ] Catalog writes and library.updated IDs equal semantic changes, not all rows.
- [ ] An unchanged 500-source pass has zero prefix reads/writes/invalidation in automated tests.
- [ ] Plan 003 CAS and plan 004 winner semantics remain covered and green.
- [ ] All commands in Commands you will need exit 0.
- [ ] git status --short lists only Scope files plus the plan status row.

## STOP conditions

Stop if plan 003/004 interfaces are absent; if skipping a prefix requires trusting mtime without current manifest safeguards; if metadata changes cannot be mapped safely and the proposed shortcut would leave stale titles/pins/topology; if targeted UI updates can produce incorrect filtered totals; or if the change requires retaining full transcripts in memory.

## Maintenance notes

Periodic recovery remains a correctness fallback, not an excuse for broad writes. New metadata sources must declare whether they require full comparison. Reviewers should compare observed read/write/event counts and verify Windows path casing. Plan 008 edits the same reconciler only after this plan lands.
