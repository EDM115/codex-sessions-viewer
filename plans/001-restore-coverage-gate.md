# Plan 001: Restore a reliable, passing coverage gate

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update only plan 001's status row in plans/README.md unless the reviewer says they maintain the index.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- package.json vitest.config.ts server/metadata/stateSnapshot.ts tests/unit/metadata/stateSnapshotRaces.test.ts tests/unit/ui/library.test.ts tests/integration/progressiveSearch.test.ts tests/unit/normalization/normalizeSession.test.ts  
> If an in-scope file changed, compare the Current state excerpts with live code. Any semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests, dx
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

The documented pnpm coverage release check is not executable as a reliable gate. The default run times out four tests at five seconds and can leave SQLite cleanup with EBUSY; a diagnostic serial run completes all 75 files/358 tests but then fails the declared branch thresholds: global 75.98% versus 80%, and server/metadata/stateSnapshot.ts 87.8% versus its 90% override. Every later behavioral plan needs trustworthy coverage, so this is the first dependency. Do not solve it by simply lowering or deleting thresholds.

## Current state

- package.json defines coverage as vitest run --coverage with no coverage-specific timeout or worker policy.
- vitest.config.ts owns all Vitest projects and coverage thresholds. Pagefind is already isolated because its atomic index rename collides on Windows.
- coverage/coverage-final.json from the diagnostic run identifies uncovered stateSnapshot.ts branches at lines 136, 225, 277, and 296.
- The largest branch deficits are in useLibraryWorkspace.ts, normalizeSession.ts, and reconciler.ts; add behavior-valued tests rather than synthetic assertions.

```ts
// package.json:8
"coverage": "vitest run --coverage",

// vitest.config.ts:14-26
coverage: {
  thresholds: {
    branches: 80,
    functions: 80,
    lines: 80,
    statements: 80,
    "server/metadata/stateSnapshot.ts": { branches: 90 },
  },
},
```

```ts
// server/metadata/stateSnapshot.ts:217-226
function snapshotDiagnostic(path: string, error: unknown): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "metadata.snapshot_invalid",
    details: { reason: error instanceof Error ? error.message : "Unknown snapshot error" },
  });
}
```

Repository conventions: Vitest tests use describe/it/expect, temporary roots are tracked and recursively removed in afterEach, and filesystem races are injected through vi.hoisted plus vi.mock; follow tests/unit/metadata/stateSnapshotRaces.test.ts. Nuxt-owned UI tests stay under tests/unit/ui; pure server/normalization tests stay in the Node project.

## Commands you will need

| Purpose                     | Command                                                                                  | Expected on success                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Baseline diagnostic         | pnpm exec vitest run --coverage --testTimeout=15000 --maxWorkers=1 --no-file-parallelism | All 75 files/358 tests execute; threshold failure is visible before changes |
| Focused state tests         | pnpm exec vitest run --project node tests/unit/metadata/stateSnapshotRaces.test.ts       | Exit 0                                                                      |
| Focused normalization tests | pnpm exec vitest run --project node tests/unit/normalization/normalizeSession.test.ts    | Exit 0                                                                      |
| Focused live tests          | pnpm exec vitest run --project node tests/integration/progressiveSearch.test.ts          | Exit 0                                                                      |
| Focused UI tests            | pnpm exec vitest run tests/unit/ui/library.test.ts                                       | Exit 0                                                                      |
| Final coverage              | pnpm coverage                                                                            | Exit 0; all configured thresholds pass                                      |
| Source gates                | pnpm format:check; pnpm typecheck; pnpm lint                                             | Each exits 0; lint may retain pre-existing warnings but adds no new warning |

## Scope

**In scope** (the only implementation/test files to modify):

- package.json — make the coverage command stable and explicit.
- vitest.config.ts — coverage-only configuration if needed; do not weaken thresholds.
- server/metadata/stateSnapshot.ts — only a behavior-neutral removal of a statically unreachable defensive branch if it cannot be meaningfully tested.
- tests/unit/metadata/stateSnapshotRaces.test.ts — retained/unavailable/error/race branches.
- tests/unit/ui/library.test.ts — high-value library-workspace abort/error/pagination branches.
- tests/integration/progressiveSearch.test.ts — deep-search cancellation/failure/terminal-state branches.
- tests/unit/normalization/normalizeSession.test.ts — protocol fallback branches with user-visible semantics.  
  **Out of scope**:
- Lowering, deleting, or excluding existing thresholds merely to get green.
- Blanket c8/istanbul ignore directives.
- Production behavior changes unrelated to removing a proven unreachable branch.
- Full real-archive Pagefind export.
- Any change to Codex input files or Git history.

## Git workflow

- Do not create a branch, stage, commit, push, use a worktree, or open a PR unless the operator explicitly authorizes it.
- If authorization is later granted, follow the repository's short conventional style, for example test: restore reliable coverage gate.

## Steps

### Step 1: Stabilize only the coverage runner

Change package.json and, only if clearer, vitest.config.ts so pnpm coverage uses the already-proven stable profile: a 15-second test timeout, one worker, and no file parallelism. Preserve the ordinary pnpm test configuration and Pagefind project isolation. Prefer explicit CLI flags in the coverage script unless a dedicated config materially reduces duplication.  
**Verify**: pnpm coverage → all test files execute without test timeouts or EBUSY cleanup; the command may still exit nonzero only because branch thresholds are not yet met.

### Step 2: Cover the state-snapshot decision branches

Extend stateSnapshotRaces.test.ts to cover: a retained valid generation after a new snapshot failure; an unavailable retained manifest; a source observation changing after successful copies; and diagnostic fallback for a non-Error throw if it can be injected without exposing private internals. If line 136 is proven unreachable by the function's non-optional contract, simplify that branch in stateSnapshot.ts rather than adding a fake test or ignore pragma; preserve the error behavior for missing required database files.  
**Verify**: pnpm exec vitest run --project node tests/unit/metadata/stateSnapshotRaces.test.ts → all tests pass; regenerated coverage reports stateSnapshot.ts branch coverage at or above 90%.

### Step 3: Add behavior-valued branch tests until global branches exceed 80%

Use coverage/coverage-final.json after the stable run to select uncovered branches in this order: useLibraryWorkspace request cancellation/error/retry and pagination; LiveReconciler deep-search cancellation/failure/terminal transitions; normalizeSession model/effort and malformed-protocol fallbacks. Add tests only for observable behavior and reuse existing fixtures/helpers. Do not target generated lines or assert implementation-private counters solely for coverage.  
**Verify after each test group**: run its focused command from Commands you will need → exit 0.

### Step 4: Confirm the gate is genuinely green

Delete no coverage expectations and do not change the threshold values. Run pnpm coverage twice to expose order-dependent cleanup or timing failures.  
**Verify**: two consecutive pnpm coverage runs → exit 0 both times; global branches ≥80%; stateSnapshot.ts branches ≥90%; statements/functions/lines remain ≥80%.

### Step 5: Run source-wide checks

Run the full non-build source gates and inspect warnings for newly introduced issues.  
**Verify**: pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration; pnpm test:performance → every command exits 0.

## Test plan

- State snapshot: retained generation, invalid current manifest, post-copy observation drift, optional missing WAL, required missing database, Error/non-Error diagnostic reason.
- Library workspace: aborted latest-wins request does not overwrite current state; failed refresh surfaces error; pagination retains/clears the correct collections.
- Progressive search: failure increments failed without completing; cancellation stops future materialization; terminal result count remains correct.
- Normalization: settings fallback before a turn, explicit turn context precedence, missing timestamps, malformed optional protocol data.
- Model new filesystem-race tests after tests/unit/metadata/stateSnapshotRaces.test.ts and protocol fixtures after tests/unit/normalization/normalizeSession.test.ts.

## Done criteria

- [ ] pnpm coverage exits 0 twice consecutively.
- [ ] Global statements/functions/lines/branches are all at least 80%.
- [ ] server/metadata/stateSnapshot.ts branch coverage is at least 90%.
- [ ] No threshold was lowered, deleted, or bypassed.
- [ ] pnpm format:check, pnpm typecheck, pnpm lint, pnpm test, pnpm test:integration, and pnpm test:performance all exit 0.
- [ ] git status --short lists only the in-scope files plus plans/README.md status if the executor updates it.
- [ ] plans/README.md marks plan 001 DONE only after all prior criteria pass.

## STOP conditions

Stop and report if the stable coverage command still has timeouts or SQLite cleanup failures twice; if reaching 80% requires changing unrelated production behavior; if an uncovered stateSnapshot branch cannot be exercised or proven unreachable; if UI coverage requires moving Nuxt-owned modules into tsconfig.custom.json; or if any test attempts to access the real Codex archive instead of fixtures.

## Maintenance notes

Keep coverage execution deterministic on Windows even if future Vitest versions improve parallel cleanup; remove serialization only with two consecutive clean coverage runs. Reviewers should reject coverage-only ignore directives and tests with no behavioral assertion. Later plans 002–010 should add their own regression tests so this baseline does not decay.
