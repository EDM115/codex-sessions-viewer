# Plan 008: Count deep-search results only at bounded milestones

> **Executor instructions**: Preserve exact terminal resultCount, cancellation, and progress semantics while removing per-session FTS recounts. Add a call-count regression seam before changing the loop. Update only plan 008's row after all gates pass.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- server/live/reconciler.ts server/cache/searchStore.ts tests/integration/progressiveSearch.test.ts tests/performance/deepSearchScale.test.ts  
> Plan 005 must be DONE first because it edits the same reconciler/invalidation flow.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: plans/005-incremental-catalog-reconciliation.md
- **Category**: perf
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

Deep search performs an exact FTS count before materialization and repeats searchCachedSessions(... limit: 1).total after every cold session. Each call executes a full COUNT plus a result SELECT over a growing FTS corpus, so S cold sessions cause S+1 exact counts and S+1 result queries even though progress already has completed/failed counters. Users need exact resultCount at start and terminal completion, not after every individual transcript.

## Current state

```ts
// server/live/reconciler.ts:477-486
const job: DeepSearchJob = {
  total: sessionIds.length,
  completed: 0,
  failed: 0,
  resultCount: searchCachedSessions(this.#database, { ...query, cursor: undefined, limit: 1 })
    .total,
};
```

```ts
// server/live/reconciler.ts:527-552
for (const sessionId of sessionIds) {
  const result = (await this.prepareSessions([sessionId], "deep-search", owner))[0];
  const updated = {
    ...current,
    completed,
    failed,
    resultCount: searchCachedSessions(this.#database, { ...query, cursor: undefined, limit: 1 }).total,
  };
  this.#publish({ type: "search.updated", ids: [id], ... });
}
```

```sql
-- server/cache/searchStore.ts:207-232
SELECT count(*) AS total FROM session_fts JOIN sessions AS s ... WHERE ...;
SELECT ... FROM session_fts JOIN sessions AS s ... WHERE ... LIMIT ? OFFSET ?;
```

Repository conventions: deep search materializes cold root sessions serially, publishes bounded job IDs over SSE, uses completed/failed for preparation progress, and cancellation stops queued owner work. Keep DeepSearchJob's public schema unchanged unless a provisional-count field is proven necessary; exact terminal state is preferred.

## Commands you will need

| Purpose            | Command                                                                                       | Expected on success   |
| ------------------ | --------------------------------------------------------------------------------------------- | --------------------- |
| Progressive search | pnpm exec vitest run --project node tests/integration/progressiveSearch.test.ts               | Exit 0                |
| Scale regression   | pnpm exec vitest run --project performance tests/performance/deepSearchScale.test.ts          | Exit 0                |
| Performance suite  | pnpm test:performance                                                                         | Exit 0                |
| Full gates         | pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration | Every command exits 0 |

## Scope

**In scope**: reconciler deep-search counting/progress; searchStore count-only helper; progressive-search integration tests; a new performance/call-count test if the integration seam cannot express it.  
**Out of scope**: persisting jobs across browser/server restarts; parallel materialization; changing FTS ranking/filter semantics; removing per-session progress events; changing the search API; plan 005 reconciliation work.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit authorization. If later authorized, use perf(search): bound deep-search recounts.

## Steps

### Step 1: Add an exact count-call regression

Add a test seam consistent with LiveReconciler's existing injectable reader/watcher options: inject or spy on a dedicated countCachedSearchResults function. For N cold sessions, assert count is called once when the job starts and once when it reaches completed, not once per session. Assert search.updated is still published for queued, running/progress, and terminal transitions. The existing three-session integration test must still finish with resultCount=3.  
**Verify**: the new test fails against df97571 by observing N+1 count/search calls.

### Step 2: Split count-only SQL from paginated search

In searchStore.ts extract a countCachedSearchResults(database, query) helper that parses the same SearchQuery and reuses the exact filter/FTS-expression builder but executes only SELECT count(*). Refactor searchCachedSessions to call the helper for total and retain its result SELECT. Do not duplicate filters or let count/search semantics drift.  
**Verify**: existing search-store and progressive-search tests pass; dedicated tests prove count-only and paginated totals agree for query, scope, project, model, cwd, tool, and hasMedia filters.

### Step 3: Count at start and terminal completion only

Use the count-only helper to initialize resultCount. During each materialization, update completed/failed and updatedAt while leaving resultCount at the last exact value. After the loop, perform one final exact count, set state=completed and resultCount together, then publish the terminal event. On cancellation, do not run a final count; on failure, retain the last exact count and error. If the final count itself fails, mark the job failed rather than reporting completed with a guessed value.  
**Verify**: progressiveSearch.test.ts covers completed, cancelled, materialization failure, and final-count failure; terminal completed count is exact and count call total is two.

### Step 4: Add a scale/call-count performance guard

Create tests/performance/deepSearchScale.test.ts using an in-memory viewer database and enough cold sessions to expose query multiplication. Prefer asserting count invocation cardinality (constant two) over brittle wall-clock thresholds; optionally record a generous duration ceiling following existing performance tests. Do not access the real archive.  
**Verify**: pnpm exec vitest run --project performance tests/performance/deepSearchScale.test.ts → exit 0 twice.

### Step 5: Run complete gates

**Verify**: pnpm test:performance; pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration → all exit 0.

## Test plan

- Zero cold sessions: one initial exact count, immediate completed state, no redundant final query unless implementation requires and tests document it.
- N successful sessions: completed=N, failed=0, exactly two counts, exact terminal results.
- Mixed success/failure: progress counters correct, terminal count reflects indexed successes.
- Cancellation after first read: no terminal recount and no further source starts.
- Initial/final count failure: job becomes failed with bounded error.
- Every SearchQuery filter yields identical total between count-only helper and paginated search.

## Done criteria

- [ ] No exact FTS count or result SELECT runs inside the per-session materialization loop.
- [ ] Completed jobs expose an exact terminal resultCount.
- [ ] For N>0 sessions, automated tests observe exactly two count calls.
- [ ] Cancellation/failure semantics and progress invalidations remain intact.
- [ ] All commands in Commands you will need exit 0.
- [ ] Only Scope files plus plan status are modified.

## STOP conditions

Stop if plan 005 is not complete; if UI code relies on exact resultCount changing after each session rather than completed/failed; if extracting count duplicates filter logic; if a test-only injection leaks into the public repository API; or if cancellation begins executing additional source work.

## Maintenance notes

Any new deep-search filter must be implemented once in buildFilters and exercised against both count-only and paginated paths. Reviewers should inspect SQL call cardinality and terminal exactness, not just elapsed time. Recovering jobs after reload remains a separate direction item.
