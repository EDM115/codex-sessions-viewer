# Plan 006: Parse and index the static asset manifest once per repository

> **Executor instructions**: This is a narrow browser-side optimization. Do not alter the asset manifest schema produced by plan 002. Add concurrent/retry tests and touch no server code. Update only plan 006's row when complete.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- app/repositories/static.ts tests/unit/ui/repositories.test.ts  
> If plan 002 changed the asset contract beyond the current schema, adapt the Current state excerpt to its final version before proceeding; semantic uncertainty is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-classify-media-references.md
- **Category**: perf
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

StaticConversationRepository caches its session index, project payload, Pagefind loader, and favicon map, but resolveAsset fetches, parses, validates, and linearly searches assets.json for every media block. Browser HTTP caching may avoid repeat transfers, but it does not avoid repeated promises, JSON parsing, Zod validation, or O(n) lookup. After plan 002 bounds the manifest, this plan makes asset resolution O(1) with one parse per repository instance.

## Current state

```ts
// app/repositories/static.ts:236-242
private indexPromise: Promise<ConversationSummary[]> | null = null;
private libraryPromise: Promise<StaticLibraryPayload | null> | null = null;
private pagefindPromise: Promise<PagefindBrowserApi> | null = null;
private faviconPromise: Promise<ReadonlyMap<string, string>> | null = null;
```

```ts
// app/repositories/static.ts:409-415
async resolveAsset(assetId: string): Promise<ResolvedAsset> {
  const manifest = assetManifestSchema.parse(await this.requester("/payloads/assets.json"));
  const asset = manifest.assets.find(({ id }) => id === assetId);
  if (asset === undefined) throw new Error("Asset not found in the static payloads.");
  return asset;
}
```

```ts
// app/repositories/static.ts:457-467 — exemplar
private favicons(): Promise<ReadonlyMap<string, string>> {
  this.faviconPromise ??= this.requester("/payloads/favicons.json")
    .then((value) => new Map(faviconManifestSchema.parse(value).favicons.map(({ origin, url }) => [origin, url])))
    .catch((error) => { this.faviconPromise = null; throw error; });
  return this.faviconPromise;
}
```

Match the favicon/index promise-reset convention so a transient requester or schema failure can be retried. Static outputs are immutable for one repository instance; no SSE invalidation is required.

## Commands you will need

| Purpose               | Command                                                 | Expected on success   |
| --------------------- | ------------------------------------------------------- | --------------------- |
| Focused UI repository | pnpm exec vitest run tests/unit/ui/repositories.test.ts | Exit 0                |
| Coverage              | pnpm coverage                                           | Exit 0                |
| Source gates          | pnpm format:check; pnpm typecheck; pnpm lint; pnpm test | Every command exits 0 |

## Scope

**In scope**: app/repositories/static.ts and tests/unit/ui/repositories.test.ts only.  
**Out of scope**: server asset endpoints; manifest production/versioning; media classification; service workers/browser cache headers; preloading assets; changing missing-asset error messages unless tests prove contract need.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit authorization. If later authorized, use perf(ui): cache static asset manifest.

## Steps

### Step 1: Add requester-count and concurrency tests

In repositories.test.ts create a StaticConversationRepository with a requester that returns at least two asset records. Resolve both IDs sequentially and concurrently; assert one request to /payloads/assets.json, correct assets returned, and an unknown ID throws without another request. Add a first-request rejection followed by success and assert the rejected promise is cleared so retry requests once more.  
**Verify**: pnpm exec vitest run tests/unit/ui/repositories.test.ts → the new request-count test fails against df97571, then passes after step 2.

### Step 2: Add one cached manifest map

Add an assetManifestPromise field whose resolved value is ReadonlyMap<string, ResolvedAsset>. Parse the manifest once, build a Map by ID, reject duplicate IDs if the schema does not already reject them, and clear the promise on rejection. resolveAsset awaits the map and performs get(assetId). Do not cache individual rejected unknown IDs separately.  
**Verify**: focused test exits 0; concurrent calls share one in-flight requester promise; retry behavior matches index/favicons.

### Step 3: Run complete source gates

**Verify**: pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test → all exit 0.

## Test plan

- Two sequential IDs, one manifest request.
- Two concurrent IDs, one in-flight request/parse.
- Unknown ID after successful load, no refetch.
- First requester/schema failure clears cache; second call retries and succeeds.
- Duplicate ID behavior is deterministic and consistent with verifier/schema.

## Done criteria

- [ ] assets.json is requested and parsed at most once after a successful load per repository instance.
- [ ] Lookup is Map-based rather than Array.find.
- [ ] Concurrent calls share the same promise.
- [ ] A rejected load is retryable.
- [ ] Focused and full commands exit 0.
- [ ] Only the two in-scope files plus plan status are modified.

## STOP conditions

Stop if plan 002 leaves the manifest mutable during one repository lifetime; if duplicate IDs are intentionally supported; if abort-signal semantics require per-call cancellation not compatible with a shared promise; or if fixing this requires server/public-contract changes.

## Maintenance notes

Any future static-manifest cache should follow the same promise/reset convention. Reviewers should assert one parse, not merely one network transfer, and ensure a failed load is not permanently poisoned.
