# Plan 009: Report static-output presence separately from verified integrity

> **Executor instructions**: Do not make doctor silently run the full verifier on every invocation. Introduce explicit structural versus integrity terminology, test both commands against the same inconsistent fixture, and preserve verify:output as the authoritative semantic gate. Update only plan 009's row when done.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- server/export/doctorReport.ts server/export/verifyOutput.ts scripts/doctor.ts scripts/verify-output.ts README.md tests/unit/export/doctorReport.test.ts tests/unit/export/verifyOutput.test.ts  
> If output status/types or verifier schema changed, stop and reconcile the terminology before editing.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-restore-coverage-gate.md
- **Category**: bug, docs, dx
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

doctor labels output available after checking file presence and basic navigator shape, while verify:output validates semantic consistency across summaries, navigators, chunks, inspectors, diagnostics, assets, routes, and local resources. In the current workspace doctor reports the existing 317-session output available, but verify:output rejects it because a session diagnostic count disagrees with the index. The snapshot may be stale, so the exporter is not proven broken; the defect is that structural presence is described as completeness/availability without saying integrity was not checked.

## Current state

```ts
// server/export/doctorReport.ts:36-41
export interface DoctorOfflineOutputReport {
  status: "available" | "missing" | "incomplete";
  sessionCount: number;
  missingFiles: string[];
  searchIndex: "pagefind" | "disabled" | "unknown";
}
```

```ts
// server/export/doctorReport.ts:363-368
return {
  status: missingFiles.length === 0 ? "available" : "incomplete",
  sessionCount: sessions.length,
  missingFiles: missingFiles.toSorted(),
  searchIndex,
};
```

```ts
// scripts/doctor.ts:33-35
State snapshot: report.snapshotManifest; offline output report.offlineOutput.status (report.offlineOutput.sessionCount sessions, search report.offlineOutput.searchIndex).
```

verifyGeneratedOutput in server/export/verifyOutput.ts is the publication-boundary authority and scripts/verify-output.ts exits nonzero on semantic mismatch. Keep that division rather than cloning hundreds of lines into doctor.

## Commands you will need

| Purpose       | Command                                                                                       | Expected on success   |
| ------------- | --------------------------------------------------------------------------------------------- | --------------------- |
| Doctor unit   | pnpm exec vitest run --project node tests/unit/export/doctorReport.test.ts                    | Exit 0                |
| Verifier unit | pnpm exec vitest run --project node tests/unit/export/verifyOutput.test.ts                    | Exit 0                |
| CLI help      | pnpm run doctor -- --help; pnpm verify:output -- --help                                       | Both exit 0           |
| Full gates    | pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration | Every command exits 0 |

## Scope

**In scope**: doctor report type/structural inspection; doctor CLI wording; shared test fixtures/refactoring needed to test doctor and verifier against the same tree; README terminology; verifyOutput only if a small exported helper is needed to share fixtures/status, not to weaken checks.  
**Out of scope**: repairing or regenerating the existing .output; making doctor perform full semantic verification by default; changing export payload versions; weakening verifier checks; full archive export; declaring an old snapshot a current exporter failure.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit authorization. If later authorized, use fix(dx): distinguish output presence from integrity.

## Steps

### Step 1: Create a shared valid/inconsistent output fixture

Extract the minimal validOutput fixture setup from verifyOutput.test.ts into a test helper or duplicate only the small setup if sharing would make the test harder to read. Create one structurally complete tree and one tree whose diagnostic/index counts drift while every required file remains. The first must pass verifier; the second must pass doctor's structural check but fail verifier.  
**Verify**: verifier unit tests pass; the new doctor characterization demonstrates current status=available for the inconsistent tree.

### Step 2: Make structural and integrity dimensions explicit

Replace ambiguous available terminology with explicit fields, preferably structuralStatus: missing | incomplete | present and integrityStatus: not-checked. If retaining status for compatibility, change available to present and add integrity: not-checked. Do not invent verified state unless doctor actually invokes verifyGeneratedOutput. Keep capabilities.offline based on structural present status, because the server can still attempt to serve it; do not equate that capability with verified publication integrity.  
**Verify**: doctor tests cover missing, incomplete, structurally present, disabled/Pagefind/unknown search, and prove structurally present can coexist with integrity not-checked.

### Step 3: Update CLI and documentation

Print wording such as offline output present, structural files found, integrity not checked; run pnpm verify:output for publication verification. README must replace static-output completeness with structural presence and explain verify:output is authoritative. Avoid exposing a failing session ID or sensitive source path in summary output.  
**Verify**: CLI/help snapshot or captured-output tests assert the new wording; a source search in README/scripts finds no claim that doctor proves static-output completeness.

### Step 4: Preserve the verifier boundary

Run the same inconsistent fixture through verifyGeneratedOutput and assert the semantic mismatch remains rejected. Do not catch/translate verifier failures into success.  
**Verify**: pnpm exec vitest run --project node tests/unit/export/doctorReport.test.ts tests/unit/export/verifyOutput.test.ts → all pass.

### Step 5: Run complete gates

**Verify**: pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration → all exit 0. Do not use the existing stale .output as a success criterion.

## Test plan

- Missing public root.
- Present root with missing index/manifest/chunk.
- Structurally present no-index output: presence=present, integrity=not-checked, offline capability true.
- Structurally present Pagefind output with required runtime.
- Structurally present but semantically inconsistent diagnostic count: doctor remains explicit not-checked; verifier fails.
- Fully valid fixture: verifier succeeds.
- CLI wording never uses complete/verified for doctor-only evidence.

## Done criteria

- [ ] Doctor's type and CLI distinguish structural presence from semantic verification.
- [ ] README no longer calls doctor a static-output completeness check.
- [ ] The same inconsistent fixture is structurally present in doctor and rejected by verifier.
- [ ] verify:output remains the authoritative publication integrity command.
- [ ] Existing output is neither regenerated nor modified.
- [ ] All commands in Commands you will need exit 0.
- [ ] Only Scope files plus plan status are modified.

## STOP conditions

Stop if changing the report type breaks an external/public contract not represented in this repository; if the only proposed solution runs the full verifier on every doctor invocation; if a shared fixture would import executable CLI modules that run unconditionally; or if output repair becomes necessary to test terminology.

## Maintenance notes

When new payload files or integrity checks are added, decide explicitly whether they are structural doctor checks or semantic verifier checks. Reviewers should reject wording that implies verification from file presence. Plan 011 must use the final terms.
