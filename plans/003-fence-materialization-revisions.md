# Plan 003: Commit materialized sessions only against the expected source revision

> **Executor instructions**: Follow the plan exactly and add the deterministic race test before changing commit behavior. A stale result must be discarded/retried without publishing ready state. Update only plan 003's row in plans/README.md after all gates pass.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- server/live/reconciler.ts server/cache/sourceManifest.ts server/cache/conversationStore.ts server/cache/catalogStore.ts tests/integration/live/lazyMaterialization.test.ts tests/unit/cache/conversationStore.test.ts tests/unit/cache/catalogStore.test.ts  
> Any semantic mismatch in the materialization/update transaction is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-restore-coverage-gate.md
- **Category**: bug, tech-debt
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

Live materialization and catalog reconciliation use different serialized queues. A materialization can read catalog revision A, yield during stable read/normalization/rich-content preparation, then commit after reconciliation has advanced the catalog to revision B. replaceCachedSession writes the normalized payload and markCatalogSessionReady updates by id only, so the catalog can report revision B ready while the cached conversation contains revision A. Later reconciliation may see matching source/catalog revisions and never repair the stale content.

## Current state

```ts
// server/live/reconciler.ts:377-406
const catalog = catalogSession(this.#database, id);
setCatalogMaterialization(this.#database, id, "loading", null);
result = await this.#updateSource(
  { path: catalog.summary.sourcePath, scope: catalog.summary.scope },
  id,
  false,
  true,
);
setCatalogMaterialization(
  this.#database,
  id,
  result.state === "ready" ? "ready" : "failed",
  result.error,
);
```

```ts
// server/cache/conversationStore.ts:263-274
withCacheTransaction(database, () => {
  writeSource(database, input.session.summary.id, input.source);
  writeSummary(database, input.session);
  markCatalogSessionReady(database, input.session.summary);
  replaceChildren(database, input.session);
  writeDiagnostics(database, input.session.summary.id, input.diagnostics);
  replaceSessionSearchRows(database, input.session, input.diagnostics);
});
```

```sql
-- server/cache/catalogStore.ts:470-477
UPDATE session_catalog
SET materialization_state = 'ready', ... summary_json = ?
WHERE id = ?
```

The catalog upsert already treats source_revision as the materialization boundary when deciding whether ready/failed state survives a cold refresh. Match that convention. Rich-content updates already reject stale session revisions in conversationStore.ts:282-286; use the same explicit refusal pattern.

## Commands you will need

| Purpose            | Command                                                                                                              | Expected on success                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Catalog store      | pnpm exec vitest run --project node tests/unit/cache/catalogStore.test.ts tests/unit/cache/conversationStore.test.ts | Exit 0                                                |
| Live race          | pnpm exec vitest run --project node tests/integration/live/lazyMaterialization.test.ts                               | Exit 0                                                |
| Related live suite | pnpm test:integration                                                                                                | Exit 0; 13 integration files remain green or increase |
| Full gates         | pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:performance                        | Every command exits 0                                 |

## Scope

**In scope**: server/live/reconciler.ts; server/cache/sourceManifest.ts; server/cache/conversationStore.ts; server/cache/catalogStore.ts; the three named test files.  
**Out of scope**: merging the materialization and reconciliation queues wholesale; retaining full live source graphs; schema changes unrelated to a compare-and-commit; changing public repository response shapes; suppressing watcher reconciliation; touching Codex inputs; full Pagefind export.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit operator authorization. If authorized later, use a conventional message such as fix(live): fence materialization by source revision.

## Steps

### Step 1: Add a deterministic failing race test

Extend lazyMaterialization.test.ts with a controlled StableJsonlReader barrier. Start materializing revision A, pause after the read begins, rewrite the fixture to revision B, invoke/await reconciliation so session_catalog.source_revision advances, then release A. Assert the final cached session and catalog either both represent B or remain non-ready pending a retry; they must never expose A as ready under B. Capture library/session invalidations and assert no ready invalidation is published for the discarded A result.  
**Verify**: pnpm exec vitest run --project node tests/integration/live/lazyMaterialization.test.ts → the new test fails against df97571 with the stale-state mismatch.

### Step 2: Thread an expected catalog revision into the cache transaction

Capture catalog.sourceRevision at the start of #materialize. Extend SessionCacheUpdateContext/ReplaceCachedSessionInput with an optional expectedCatalogSourceRevision used only by live catalog materialization; static export remains unaffected. At the start of replaceCachedSession's existing transaction, compare session_catalog.source_revision and source_path for the session. If either differs, perform no writeSource/writeSummary/children/diagnostic/FTS mutation and return a typed stale outcome rather than a generic failure.  
**Verify**: pnpm exec vitest run --project node tests/unit/cache/conversationStore.test.ts tests/unit/cache/catalogStore.test.ts → tests prove matching revision commits atomically, mismatching revision changes zero relevant rows, missing catalog remains allowed only for static/non-catalog callers, and auxiliary rows are never promoted.

### Step 3: Make ready marking itself compare-and-set

Change markCatalogSessionReady to accept the expected source revision when updating an existing catalog row. Add source_revision = ? and source_path = ? to the UPDATE predicate and return whether exactly one row changed. Do not mark ready or overwrite summary_json when the predicate fails. Keep the existing new-row/static path behavior explicit rather than relying on null/undefined ambiguity.  
**Verify**: catalogStore focused tests → exact changed-row counts and summary/materialization state pass for match, mismatch, auxiliary, and new-row cases.

### Step 4: Handle stale outcomes without false failure/ready publication

Teach SessionCacheUpdater and LiveReconciler to distinguish stale-catalog from parse/storage failure. Re-read the catalog and retry the latest source revision in a bounded way (one immediate retry is acceptable); if it changes again, leave/requeue the item rather than marking failed with a parser diagnostic. Publish library/session updates only for the revision actually committed. Preserve cancellation and close behavior of MaterializationQueue.  
**Verify**: the race test passes and observes B content/revision with no transient ready event for A; an always-changing fixture terminates boundedly without an infinite loop.

### Step 5: Run full verification

Run the complete coverage and live suites.  
**Verify**: pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration; pnpm test:performance → all exit 0.

## Test plan

- Matching expected revision commits source manifest, normalized session, children, diagnostics, FTS, and ready catalog state in one transaction.
- Mismatched source revision and mismatched source path mutate none of those tables.
- Reconciliation advances A→B while A materializes: only B becomes ready.
- Source advances twice: retry/requeue is bounded and does not publish stale ready.
- Static export/no-catalog cache writes retain current behavior.
- Auxiliary catalog rows remain excluded.

## Done criteria

- [ ] Every live materialization cache replacement carries the catalog revision/path captured before its read.
- [ ] The cache transaction writes nothing when the expected catalog revision/path no longer matches.
- [ ] markCatalogSessionReady uses a compare-and-set predicate and reports zero-row mismatches.
- [ ] Stale outcomes are not reported as parser failures and do not publish ready invalidations.
- [ ] The deterministic A/B race regression test passes.
- [ ] All commands in Commands you will need exit 0.
- [ ] git status --short contains no files outside Scope plus plans/README.md status.

## STOP conditions

Stop if source_revision is not stable enough to act as the catalog CAS token; if the updater cannot avoid writing old cache rows before detecting a mismatch; if the only proposed fix is to serialize all background work behind transcript parsing; if a retry can be unbounded; or if static export behavior would require a public-contract migration.

## Maintenance notes

Any future materialization side effect—rich content, search rows, diagnostics, assets—must remain inside or downstream of the successful revision fence. Reviewers should inspect zero-write behavior on mismatch and invalidation ordering, not only the final happy-path session. Plan 005 must preserve this CAS when optimizing reconciliation.
