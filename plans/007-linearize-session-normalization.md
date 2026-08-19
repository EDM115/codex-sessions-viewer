# Plan 007: Derive session settings and timestamps in linear time

> **Executor instructions**: Preserve normalized output byte-for-byte at the contract level. Add characterization and scale tests before replacing scans. Do not combine this with unrelated parser cleanup. Update only plan 007's row when complete.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- server/normalization/normalizeSession.ts tests/unit/normalization/normalizeSession.test.ts tests/performance/normalizationScale.test.ts  
> If normalizeSession's event/turn ordering changed since df97571, stop and re-derive the algorithm from live code.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/001-restore-coverage-gate.md
- **Category**: perf, tech-debt
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

For each assembled turn lacking model or effort evidence, latestSettingsBefore scans all events from the beginning until the turn offset. sessionTimestamps separately maps/sorts all event timestamps and is called twice. Long protocol-heavy sessions therefore repeat work approaching turns × events when the same state can be derived in one forward pass. The change should be internal and preserve every summary/turn/raw-event value.

## Current state

```ts
// server/normalization/normalizeSession.ts:918-965
function latestSettingsBefore(events, offset) {
  let model = null;
  let effort = null;
  for (const event of events) {
    if (event.byteStart > offset) break;
    if (event.type === "event_msg" && event.payloadType === "thread_settings_applied") {
      model = stringValue(settings?.["model"]) ?? model;
      effort = stringValue(settings?.["reasoning_effort"]) ?? effort;
    }
  }
  return { model, effort };
}
// turnModelEvidence calls this for every turn missing explicit evidence.
```

```ts
// server/normalization/normalizeSession.ts:1001-1012,1053,1140
const timestamps = events.map(...).filter(...).toSorted(...);
const fallbackTimestamp = sessionTimestamps(events, meta.timestamp).createdAt;
// later:
const timestamps = sessionTimestamps(events, meta.timestamp);
```

Repository conventions: records preserve byteStart/byteEnd; turn assembly establishes occurrence-stable IDs; explicit turn_context model/effort wins and thread_settings_applied only fills missing values; malformed optional evidence degrades rather than aborts normalization. Follow tests/unit/normalization/normalizeSession.test.ts jsonlRecords helper.

## Commands you will need

| Purpose            | Command                                                                                 | Expected on success   |
| ------------------ | --------------------------------------------------------------------------------------- | --------------------- |
| Unit normalization | pnpm exec vitest run --project node tests/unit/normalization/normalizeSession.test.ts   | Exit 0                |
| Scale test         | pnpm exec vitest run --project performance tests/performance/normalizationScale.test.ts | Exit 0                |
| Performance suite  | pnpm test:performance                                                                   | Exit 0                |
| Full gates         | pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test                  | Every command exits 0 |

## Scope

**In scope**: normalizeSession.ts, existing normalization unit test, and new tests/performance/normalizationScale.test.ts.  
**Out of scope**: changing public normalized schemas/IDs; reordering turns/events; modifying token/tool/activity logic; changing parser versions solely for an internal equivalent optimization; real archive benchmarks; broad function splitting.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit authorization. If later authorized, use perf(normalization): derive settings and timestamps once.

## Steps

### Step 1: Add equivalence characterization

Create records with multiple thread_settings_applied changes before/between turns; turns with full, partial, and absent explicit turn_context evidence; equal/out-of-order/null timestamps; no events; and meta timestamp fallback. Assert exact models, efforts, createdAt, updatedAt, turns, raw-event IDs, and revision. Save the current normalized result for the fixture only as explicit assertions, not a broad opaque snapshot.  
**Verify**: unit normalization test exits 0 before implementation.

### Step 2: Compute timestamps once without sorting

During the initial parsed-event pass, or in one dedicated pass, track the earliest and latest valid timestamp using Date.parse comparison while preserving the exact fallback rules: meta timestamp overrides createdAt; latest event timestamp overrides meta for updatedAt; epoch is last fallback. Call the helper once and reuse its result for fallbackTimestamp and summary. Handle equal/invalid timestamp behavior exactly as current tests establish.  
**Verify**: unit test exits 0 and a source search shows one session timestamp derivation call in normalizeSession.

### Step 3: Precompute settings evidence in one forward pass

Build a settings timeline or map for turn-start offsets by advancing through byte-ordered events once. Each turn receives the latest model/effort at or before its first event offset; turn_context values continue to override each available field independently. Do not run Array.find/filter over all prior events inside the turn loop. If turns are not guaranteed byte-order sorted, sort only lightweight turn-offset references and restore output order rather than sorting full event payloads.  
**Verify**: unit tests cover partial explicit evidence and settings changes at exact/either side of turn boundaries; outputs match characterization.

### Step 4: Add a scale regression

Generate in-memory JSONL records for increasing event/turn counts with periodic settings changes. Use the performance project's existing generous timing style and repeat/median measurement to avoid one-run noise. Assert doubling input does not approach quadratic growth (for example, median 2× workload stays below 3× the smaller workload) and place an absolute ceiling generous enough for managed Windows CI. Do not access the real archive.  
**Verify**: pnpm exec vitest run --project performance tests/performance/normalizationScale.test.ts → exit 0 on two consecutive runs.

### Step 5: Run full gates

**Verify**: pnpm test:performance; pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test → all exit 0.

## Test plan

- Settings before first turn, between turns, at the exact first-event offset, and after last turn.
- Explicit turn_context overrides both or one of model/effort; fallback fills only missing fields.
- Null, equal, out-of-order, invalid, and meta-only timestamps.
- Empty/malformed optional events remain recoverable.
- Scale fixture proves near-linear growth without real data.

## Done criteria

- [ ] No per-turn scan starts at the beginning of allEvents.
- [ ] Session timestamp min/max is derived once without sorting the full event array.
- [ ] Existing and new normalization assertions are identical at the public contract.
- [ ] Scale test passes twice and remains in the performance project.
- [ ] All commands in Commands you will need exit 0.
- [ ] Only Scope files plus plan status are modified.

## STOP conditions

Stop if event byteStart order is not stable enough to drive the forward pass; if current invalid timestamp ordering is undefined and changing it alters output; if exact equivalence requires a parser-version migration; if the scale assertion is flaky across two local runs; or if optimization touches unrelated activity/token semantics.

## Maintenance notes

Future settings-like protocol state should extend the single timeline rather than reintroducing prior-event scans. Reviewers should compare normalized fixture outputs and performance scaling, not only wall-clock improvement on one machine.
