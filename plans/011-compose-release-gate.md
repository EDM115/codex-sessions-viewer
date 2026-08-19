# Plan 011: Provide one visible, reproducible local release command

> **Executor instructions**: Compose existing commands without hiding their output or weakening their semantics. PNPM output must remain live. Do not add CI or publish anything unless separately requested. Update only plan 011's row after the composed command completes successfully.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- package.json README.md scripts/verify-release.ts tests/unit/verifyRelease.test.ts  
> If plans 001 or 009 are not DONE, stop because coverage reliability and output terminology are dependencies.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-restore-coverage-gate.md, plans/009-clarify-output-integrity.md
- **Category**: tests, dx
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

The repository has strong individual checks but no single command represents the local release contract. README lists nine manual commands and omits format:check, allowing documentation and actual gates to drift. A visible composed command lets maintainers and executor agents run the same ordered checks while preserving this project's Windows troubleshooting and the distinction between source/release checks and static-output verification.

## Current state

```json
// package.json:6-23 — individual scripts only
"coverage": "vitest run --coverage",
"format:check": "oxfmt --check",
"lint": "oxlint",
"test": "vitest run",
"test:e2e": "playwright test",
"test:integration": "vitest run --project node tests/integration --passWithNoTests",
"test:performance": "vitest run --project performance",
"typecheck": "nuxt typecheck && tsc -p tsconfig.custom.json",
"verify:output": "jiti scripts/verify-output.ts"
```

```text
// README.md:130-141
pnpm exec nuxt prepare
pnpm test
pnpm test:integration
pnpm test:performance
pnpm coverage
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
```

Repository conventions: use PNPM directly, never a buffering wrapper; Jiti CLI entrypoints run unconditionally and should import helpers from a separate module if tests need them; Pagefind tests stay isolated; build/E2E may require a normal elevated Windows shell only when sandbox profile readlink is denied. Git actions remain user-controlled.

## Commands you will need

| Purpose          | Command                      | Expected on success                                           |
| ---------------- | ---------------------------- | ------------------------------------------------------------- |
| Source gate      | pnpm verify:source           | Exit 0 with live output from every child command              |
| Release gate     | pnpm verify:release          | Exit 0 after source, build, and E2E checks                    |
| Output integrity | pnpm verify:output -- --help | Exit 0; documented as separate and requiring generated output |
| Script listing   | pnpm run                     | verify:source and verify:release are listed                   |

## Scope

**In scope**: package.json and README.md; only if shell composition is not portable/visible enough, add scripts/verify-release.ts plus tests/unit/verifyRelease.test.ts.  
**Out of scope**: GitHub Actions or other CI; dependency upgrades; automatic export/full Pagefind; auto-elevation; hiding/redirecting child output; staging/committing/pushing; changing individual gate semantics; treating verify:output as runnable without a fresh representative output.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit authorization. If later authorized, use chore(dx): compose local release verification.

## Steps

### Step 1: Define the source and release contracts

Add verify:source that runs, in a documented order, pnpm exec nuxt prepare, pnpm format:check, pnpm typecheck, pnpm lint, pnpm test, pnpm test:integration, pnpm test:performance, and pnpm coverage. Add verify:release that runs verify:source, pnpm build, then pnpm test:e2e. Keep verify:output separate because it verifies a selected generated publication, not source correctness. Do not remove existing scripts.  
Prefer package-script chaining if it is portable across supported PowerShell/PNPM environments and streams output. If not, create a tiny Jiti orchestrator that uses the actual PNPM executable with stdio: inherit, exits immediately on the first nonzero child, forwards Ctrl+C, and never invokes RTK or captures logs.  
**Verify**: pnpm run lists both scripts; deliberately run the helper with a harmless injected failing test command only through a unit-test seam and assert later commands do not start.

### Step 2: Document one canonical workflow

Replace the manual README list with pnpm verify:source for normal source validation and pnpm verify:release for full release readiness. List the expanded ordered commands immediately below so failures remain diagnosable. Add pnpm verify:output only under the separate requirement for a newly generated representative output and use plan 009's structural-versus-integrity terminology. Include format:check. Preserve Windows notes for TEMP/Pagefind and readlink elevation.  
**Verify**: a source search finds one canonical release order in README and every named package script exists.

### Step 3: Run the composed gates

Run the source gate in the normal shell. Run the release gate; if build/E2E alone fails with the documented sandbox readlink denial, rerun the exact release command in a normal elevated shell rather than adding auto-elevation.  
**Verify**: pnpm verify:source → exit 0; pnpm verify:release → exit 0 with visible output and final E2E 13/13 or the then-current higher count.

### Step 4: Confirm fail-fast behavior and scope

Temporarily exercise fail-fast behavior only through tests or a configurable helper—not by editing a real test to fail. Assert child environment/arguments do not leak secrets and Ctrl+C/exit code propagate. If package chaining is used, PNPM/shell provides this and no helper test is required.  
**Verify**: helper unit test exits 0 if helper exists; git status --short contains only Scope files plus plan status.

## Test plan

- verify:source includes every intended source gate exactly once and format:check is present.
- verify:release invokes source, build, E2E in order.
- First failure stops later commands and returns the same nonzero status.
- Child output is inherited/live, not buffered.
- verify:output remains separate and documentation does not run it against an arbitrary stale .output.
- No CI/publish/Git mutation is introduced.

## Done criteria

- [ ] pnpm verify:source exits 0.
- [ ] pnpm verify:release exits 0 and displays each child command's progress.
- [ ] README has one canonical release workflow and includes format:check.
- [ ] verify:output is documented separately as publication integrity verification.
- [ ] No auto-elevation, CI, export, Git, or network publishing behavior is added.
- [ ] git status --short lists only Scope files plus plan status.
- [ ] plans/README.md marks plan 011 DONE only after the composed release run succeeds.

## STOP conditions

Stop if plan 001 or 009 is incomplete; if command chaining buffers output on supported Windows PNPM; if the only implementation requires a platform-specific shell not covered by engines/docs; if the composed gate would relaunch full indexed Pagefind export; if it requires auto-elevation; or if an existing gate is intentionally non-release and its inclusion is ambiguous.

## Maintenance notes

When adding/removing a release gate, update package scripts and the expanded README list in the same change. Reviewers should run the composed command, not infer it from individual scripts. CI may call verify:release later, but adding CI remains a separate maintainer decision.
