# Plan 004: Select one duplicate session source consistently in live and static modes

> **Executor instructions**: Add live/static parity tests before changing discovery. Keep source reads bounded and stable; do not parse or retain every full transcript merely to choose among duplicates. Update only plan 004's row in plans/README.md after all gates pass.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- server/normalization/metadataMerge.ts server/ingestion/discoverSources.ts server/ingestion/sessionMetaPrefix.ts server/live/catalogBuilder.ts server/export/exportPipeline.ts tests/unit/normalization/metadataMerge.test.ts tests/unit/live/catalogBuilder.test.ts tests/integration/export/exportPipeline.test.ts  
> If a named integration test file does not exist, create the narrowest equivalent under tests/integration/export; if the production paths no longer match the excerpts, stop.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-restore-coverage-gate.md
- **Category**: bug, tech-debt
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

The same session ID can exist under active and archived rollout paths or in multiple copies. Live catalog construction currently keeps the first lexically sorted prefix and ignores later copies, while static export updates every source in lexical order so later cache upserts win. The user can therefore see different transcript content, scope, timestamps, or preparation state between live and static modes. A tested newest-stable-complete selector already exists but production does not use it.

## Current state

```ts
// server/normalization/metadataMerge.ts:121-131
export function selectPreferredSessionSource(candidates: readonly SessionSourceCandidate[]) {
  const eligible = candidates
    .filter(({ stable, complete }) => stable && complete)
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  const selected = eligible[0] ?? null;
}
```

```ts
// server/ingestion/discoverSources.ts:119-122
rollouts: [...active.rollouts, ...archived.rollouts].toSorted((left, right) =>
  left.path.localeCompare(right.path),
),
```

```ts
// server/live/catalogBuilder.ts:356-378
const seenIds = new Set<string>();
if (seenIds.has(id)) {
  diagnostics.push(/* duplicate ignored */);
  continue;
}
seenIds.add(id);
```

```ts
// server/export/exportPipeline.ts:380-407
for (const source of discovery.rollouts) {
  const result = await updater.update(source, { force: options.force });
  // every duplicate is applied to the same session cache id
}
```

Repository conventions: source discovery is path-deterministic; prefix reads are capped at 4096 bytes with concurrency 32; changing files are retried rather than trusted; duplicate diagnostics use source.duplicate_session and contain paths/counts but no transcript data. Preserve those rules.

## Commands you will need

| Purpose             | Command                                                                                               | Expected on success                      |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Selector unit tests | pnpm exec vitest run --project node tests/unit/normalization/metadataMerge.test.ts                    | Exit 0                                   |
| Live catalog        | pnpm exec vitest run --project node tests/unit/live/catalogBuilder.test.ts                            | Exit 0                                   |
| Static parity       | pnpm exec vitest run --project node tests/integration/export/exportPipeline.test.ts --passWithNoTests | Exit 0 and the created test is collected |
| Integration         | pnpm test:integration                                                                                 | Exit 0                                   |
| Full gates          | pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:performance         | Every command exits 0                    |

## Scope

**In scope**: metadataMerge.ts selector; discovery/prefix code needed to produce stable/complete/mtime candidates; live catalog preselection; static export preselection; the three named test areas.  
**Out of scope**: choosing by lexical path alone; parsing all full transcripts during live startup; mutating/moving/deleting duplicate Codex files; changing session IDs; hiding duplicate diagnostics; changing active/archive source directory semantics; full archive export.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit operator authorization. If later authorized, use a message such as fix(ingestion): unify duplicate source selection.

## Steps

### Step 1: Add a cross-mode duplicate fixture

Create two stable complete JSONL fixtures with the same session ID, distinct user-visible content/revisions, distinct mtimes, and one active plus one archived path. Add a third changing or incomplete candidate. Characterize the intended policy: newest stable complete wins; ties use normalized path lexical order; the selected path determines scope; changing/incomplete candidates never replace a stable complete source. Assert exactly one source.duplicate_session diagnostic with candidate count and selected path.  
**Verify**: selector unit tests pass; new live/static parity tests fail against df97571 because the modes select different content/source.

### Step 2: Build one duplicate-only preselection function

Create one production function that groups discovered candidates by session ID derived from the existing bounded prefix/id-hint path and delegates the final choice to selectPreferredSessionSource. Unique session IDs must remain prefix-only. For groups with more than one candidate, use the existing stable JSONL reader/parser to determine stable and complete accurately; complete means the parser has no pending partial record and no fatal identity/envelope failure, not merely that the file ends in LF. Duplicate groups are rare, so full stable reads are acceptable only for those groups; process candidates one at a time and release their record graphs after recording candidate facts. Do not increase the global 4096-byte prefix for unique guardian instructions. Sources whose identity cannot be safely determined remain path-unique and proceed to normal diagnostics.  
**Verify**: a focused test proves unique sources read only bounded prefixes, duplicate candidates receive full stable completeness checks, changing/incomplete duplicates are unselected, a valid final JSON record without trailing LF follows the parser's established completion semantics, and duplicate record graphs are not retained after selection.

### Step 3: Use the selected set in live catalog construction

Replace seenIds first-wins behavior with the shared preselection result. Feed only selected prefix/source pairs into coldSummary/topology/upsert. Include duplicate diagnostics from the selector and remove the misleading metadata.snapshot_invalid duplicate diagnostic. Ensure removed/non-selected prior sources are reconciled without deleting the selected session cache.  
**Verify**: pnpm exec vitest run --project node tests/unit/live/catalogBuilder.test.ts → active/archive duplicate, tie, changing, auxiliary, and removal cases pass.

### Step 4: Use the same selected set in static export

Before SessionCacheUpdater.update, select sources with the same function and loop only over selected sources. Progress totals and transformed/reused/failed counts must use the selected count; duplicate diagnostics remain part of the export report. Prefer handing the selected stable read to SessionCacheUpdater or reusing a matching manifest observation; if that would make updater ownership unsafe, one duplicate-only reread is acceptable and must be documented/tested. Unique sources must not gain an extra full read.  
**Verify**: static parity test exports the same selected source/scope/content as live; updater is called once for the duplicate group; output verification passes on the fixture.

### Step 5: Run complete gates

Run focused, full, integration, performance, and coverage gates without a real archive export.  
**Verify**: all commands in Commands you will need exit 0.

## Test plan

- Single source produces no duplicate diagnostic.
- Newest stable complete source wins across active/archive.
- Equal mtime uses deterministic normalized-path tie-break.
- Newer changing source and newer incomplete source do not displace stable complete.
- No stable complete candidate yields no selected source and a retry-oriented diagnostic.
- Live and static select identical source path, scope, title/content, and revision.
- Removing the losing duplicate does not remove the selected session; removing the winner promotes the next eligible source on reconciliation.

## Done criteria

- [ ] One shared selector determines duplicate winners for live and static flows.
- [ ] Live and static parity test proves identical selected source/scope/content.
- [ ] Unique-source discovery remains prefix bounded; only duplicate groups receive full stable completeness reads.
- [ ] source.duplicate_session is emitted once per duplicate group with bounded details.
- [ ] No Codex source is mutated, moved, or deleted.
- [ ] All focused and full commands exit 0.
- [ ] git status --short lists only Scope files plus the plan status row.

## STOP conditions

Stop if session IDs cannot be derived for duplicates without parsing every unique transcript; if duplicate completeness cannot reuse the existing stable JSONL semantics; if selecting a winner would silently discard distinct sessions that only share a malformed fallback ID; if live/static metadata semantics require different winners; or if the only approach mutates the Codex archive.

## Maintenance notes

Any new source directory or import mechanism must feed candidates through this selector before catalog/cache updates. Reviewers should inspect active/archive scope, Windows path casing, changing-file behavior, and diagnostics. Plan 005 must preserve winner changes as explicit changed IDs.
