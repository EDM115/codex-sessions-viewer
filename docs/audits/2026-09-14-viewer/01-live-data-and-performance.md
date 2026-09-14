# Live data loading and performance audit
Date: 2026-09-14. Initial checkout supplied by the coordinating audit: `a7765ac`. Source locations below refer to that audit snapshot and should be rechecked after implementation changes.  
Scope: live repository reads, source materialization, rich-content preparation, reconciliation, backend-driven library invalidation, and navigator parity. Frontend document navigation and timeline rendering have separate owners in this audit. This report proposes implementation work; it does not apply it.  
Evidence labels: **executed** means a bounded probe was run during this audit; **source-confirmed** means the behavior follows from the current call chain; **not measured** means its elapsed time, memory impact, or browser manifestation still needs profiling. No real archive export or full indexing run was performed. The probes used existing synthetic fixtures and in-memory SQLite. No security audit was performed.

## Findings and recommended implementation order

| ID | Priority | Problem | Evidence | First corrective step |
| --- | --- | --- | --- | --- |
| DATA-01 | P1 | Every warm API read reconstructs the whole conversation before its bounded read | Executed SQL trace and 500-turn timing | Replace full reconstruction used as an existence check |
| DATA-02 | P1 | Cold opens wait for whole-session rich preparation; a visible prefetch can block an open | Source-confirmed, cold latency not measured | Separate normalized availability from requested-chunk enrichment |
| DATA-03 | P1 for long active sessions | Live appends cannot use the updater's append path under production configuration | Source-confirmed | Design bounded incremental state and changed-turn updates |
| DATA-04 | P2 | Startup performs three discovery passes and watcher batches revisit the entire catalog | Executed startup count; source-confirmed archive-wide refresh | Coalesce startup passes and process watcher changes incrementally |
| DATA-05 | P2 | Per-session materialization events discard all sidebar pages and trigger repeated reloads | Source-confirmed, browser manifestation not measured | Merge affected rows and preserve loaded page extents |
| DATA-06 | P2 | Live navigator uses initial assistant commentary instead of the final answer | Source-confirmed semantic mismatch | Unify compact navigator generation across live and static modes |

DATA-01 is independently fixable and should land before larger materialization work. DATA-02 and DATA-03 share normalization, revision, and enrichment boundaries and need a coordinated design. DATA-04 can be implemented independently if it preserves source-revision fences. DATA-05 requires frontend/backend coordination and is listed here because backend event production triggers it. DATA-06 can be fixed alongside compact navigator storage, or separately with a parity-preserving query change.  
Do not interpret the synthetic milliseconds below as a prediction of a user's end-to-end loading time. The measured regression establishes unnecessary work in the actual repository path; it does not include HTTP, SSR, browser rendering, real raw-event volume, or concurrent background reconciliation.
The coordinating agent subsequently executed the exact report snippets again. The warm-read repeat returned 1.2265 ms for the direct chunk query and 23.3807 ms for the real repository path; it reproduced the same unbounded SQL preflight. The startup snippet again returned three discovery passes. These are separate short synthetic runs with timing variability, not a stable universal multiplier or a before/after optimization comparison.

## DATA-01: warm reads rebuild the entire session
**Observed behavior:** a request for one turn chunk first reads and validates every turn and every raw event in the cached session. A session summary, navigator, and inspector request has the same readiness preflight. The full objects are discarded after their existence is established.  
**User impact:** opening or switching a thread invokes multiple session endpoints; loading additional history repeats this preflight. Work that should depend on the requested chunk instead grows with all historical turns and raw payload bytes. The synchronous SQLite reads, JSON parsing, and schema validation occupy the server event loop.

### Exact call chain

1. `server/live/repository.ts`, `getSession`, `getTurnNavigator`, `getTurns`, and `getInspector`, approximately lines 109-157: each awaits `this.#materializer.ensureMaterialized(id)`.
2. `server/live/reconciler.ts:628-629`: `ensureMaterialized` calls `prepareSessions([id], "open", "open:<id>")`.
3. `server/live/reconciler.ts:603-605`: the already-ready branch calls `getCachedSession(this.#database, id) !== null`.
4. `server/cache/conversationStore.ts:371-407`: `getCachedSession` loads the summary, all `turns.payload_json` ordered by turn index, and all `raw_events.payload_json` ordered by source order. `includeRawEvents` defaults to enabled. Every returned JSON value is parsed and schema-validated.
5. Only then does `server/cache/repositoryStore.ts:223` perform the requested bounded chunk query.

The same expensive existence-check pattern occurs in `server/live/reconciler.ts:531` and the unchanged-source branch around lines 465-466. Fix all logically equivalent checks; do not leave one path that still rebuilds the session.  
The critical SQL trace from the actual live repository probe was:

```sql
SELECT * FROM session_catalog WHERE id = ?;
SELECT summary_json FROM sessions WHERE id = ?;
SELECT payload_json FROM turns WHERE session_id = ? ORDER BY turn_index;
SELECT id, turn_id, type, timestamp, payload_json FROM raw_events WHERE session_id = ? ORDER BY source_order;
SELECT turn_count, revision FROM sessions WHERE id = ?;
SELECT turn_index FROM turns WHERE session_id = ? AND id = ?;
SELECT payload_json FROM turns WHERE session_id = ? ORDER BY turn_index LIMIT ? OFFSET ?;
```

### Executed reproduction and results
Run the following from the repository root in PowerShell 7. It imports project TypeScript through the installed `jiti`, writes only an in-memory SQLite database, reads the existing synthetic fixture, and does not start watchers or enumerate the user's Codex directory. Module loading may use the normal jiti cache; the probe itself creates no persistent viewer database. The arbitrary `C:/fixtures` paths are labels for this cached synthetic session and are not read as rollout sources on the warm path.

```powershell
@'
import { createJiti } from 'jiti';
const jiti = createJiti(process.cwd() + '/');
const { openCacheDatabase } = await jiti.import('./server/cache/database.ts');
const { replaceCachedSession } = await jiti.import('./server/cache/conversationStore.ts');
const { getCachedTurnChunk } = await jiti.import('./server/cache/repositoryStore.ts');
const { LiveReconciler } = await jiti.import('./server/live/reconciler.ts');
const { LiveConversationRepository } = await jiti.import('./server/live/repository.ts');
const { InvalidationBus } = await jiti.import('./server/live/invalidationBus.ts');
const { normalizedRolloutFixture, cachedSource } = await jiti.import('./tests/fixtures/cache/normalized.ts');
const { representativeLargeSession } = await jiti.import('./tests/performance/fixtures.ts');
const source = await normalizedRolloutFixture({ name: 'modern.jsonl', sourcePath: 'C:/fixtures/audit-readonly.jsonl', scope: 'active', revision: 'sha256:audit' });
const session = representativeLargeSession(source);
const database = openCacheDatabase(':memory:');
replaceCachedSession(database, { session, diagnostics: [], source: cachedSource(session) });
const bus = new InvalidationBus();
const reconciler = new LiveReconciler({ database, bus, codexHome: 'C:/fixtures', cacheDir: 'C:/fixtures', fetchFavicons: false });
const repository = new LiveConversationRepository(database, bus, reconciler);
const sql = [];
const originalPrepare = database.prepare.bind(database);
database.prepare = (statement) => { sql.push(statement); return originalPrepare(statement); };
const query = { targetTurnId: 'scale-turn-487', limit: 20 };
await repository.getTurns(session.summary.id, query);
console.log(JSON.stringify({ firstLiveReadSql: sql }, null, 2));
async function measure(operation) {
  const times = [];
  for (let index = 0; index < 12; index += 1) {
    const started = performance.now();
    await operation();
    times.push(performance.now() - started);
  }
  return times.toSorted((left, right) => left - right)[6];
}
console.log(JSON.stringify({ turns: session.turns.length, rawEvents: session.rawEvents.length, directChunkMedianMs: await measure(() => getCachedTurnChunk(database, session.summary.id, query)), realRepositoryMedianMs: await measure(() => repository.getTurns(session.summary.id, query)) }));
await reconciler.close();
database.close();
'@ | & .\node_modules\node\bin\node.exe --input-type=module
```

| Measurement | Audit result |
| --- | --- |
| Synthetic turns | 500 |
| Synthetic raw events | 0 |
| Requested turns | 20, containing target `scale-turn-487` |
| Iterations per path | 12 |
| Direct chunk median | 2.4083 ms |
| Actual repository plus actual reconciler median | 23.1848 ms |
| Ratio in this run | Approximately 9.6 times slower |

The statistic is the upper middle observation of 12 sorted durations, as shown explicitly in the code. This was one bounded diagnostic run, not a multi-machine benchmark. The SQL trace is the stronger deterministic evidence. Real raw events can be far larger than visible transcript prose; this fixture had none, so the probe does not quantify that additional cost.

### Remedy, invariants, and acceptance
Add or reuse a cheap cache-presence/readiness helper based on `SELECT 1`, possibly with revision fields when required by the existing catalog fence. Use it in readiness checks. `includeRawEvents: false` is insufficient because it still reconstructs all turns. Do not replace the current correctness checks with an unverified global in-memory boolean.  
Preserve missing-session errors, auxiliary-session exclusion, materialization queue deduplication, source-path/revision fencing, and recovery when a catalog entry says ready but normalized storage is absent. Full reconstruction remains legitimate for export or a transformation that actually needs all turns.  
Acceptance tests must use the real `LiveReconciler` as the repository materializer. Cover warm summary, navigator, bounded turns, and inspector reads. Assert no unbounded `turns`/`raw_events` reconstruction is issued by readiness checks, and add substantial unrelated raw payloads so a regression is observable. A targeted inspector may legitimately fetch its referenced raw events; do not ban all raw-event reads indiscriminately. Verify that a missing normalized session under a ready catalog entry still causes correct recovery rather than false success.  
Existing gap: `tests/performance/repositoryScale.test.ts` constructs `LiveConversationRepository` without a materializer for its repository example, invoking the default no-op readiness implementation. Its timing comparison calls `getCachedTurnChunk` directly. Both bypass the actual failing preflight. Add structural query assertions as the stable guard; retain relative timing only as supporting performance evidence.

## DATA-02: cold opens depend on full rich preparation and an active background worker
**Source-confirmed:** `server/live/reconciler.ts:485-496` reconstructs all normalized turns, attaches guardian reviews, enriches subagent activity, and awaits `#prepareRichContent` before materialization settles. `#prepareRichContent` calls `prepareConversationForExport` and then `updateCachedSessionRichContent`.  
`server/export/prepareConversation.ts:105-135` iterates every turn, message, and reasoning activity and awaits rich-text parsing for placeholders. The rest of the function extracts referenced/embedded media, gathers origins, and resolves favicons. `server/cache/conversationStore.ts:315-355` then validates and writes enriched turn/message/activity payloads. Even a request for the first 20 turns waits behind this whole-session pipeline. Favicon resolution uses the live-mode implementation; this report does not claim every favicon resolution blocks on network access.  
Guardian handling also reads auxiliary children sequentially in `server/live/reconciler.ts`, `#guardianReviews`, before the rich preparation step. The number and size of auxiliary children is not bounded by the turn-page size.  
Visible preparation is automatic: `app/composables/useLibraryWorkspace.ts:386-414` observes rows with `IntersectionObserver` and queues them for materialization. `server/live/materializationQueue.ts:73-88` can promote only queued entries; lines 118-129 refuse to drain while another entry is active. A user-open request for thread B therefore waits for already-running visible thread A, even though open priority ranks higher. `cancelOwner` similarly removes queued work only.  
**Not measured:** cold first-chunk latency, event-loop blocking duration, rich-parser cost distribution, and real waiting time behind a large visible thread. These require controlled fixtures and browser/API profiling. The serialization and full-session dependency are established by source, not by a claim that any one subsystem consumes a particular number of seconds.

### Proposed implementation boundaries

1. Separate source discovery/normalization readiness from rich-content readiness. Decide explicitly what the API can serve while enrichment is pending and how a revision identifies that state.
2. Enrich the requested turn chunk before enrichment of offscreen history. Cache rich content by source revision and turn identity so repeated requests do not redo parsing.
3. Make visible prefetch lightweight or interruptible at chunk boundaries. Promote open work before additional background chunks, while preserving fairness and bounded memory.
4. Move CPU-heavy parsing/normalization to a worker if profiling confirms event-loop stalls. Adding more promises or queue concurrency on the same event loop does not make synchronous SQLite/JSON/schema work parallel.
5. Preserve guardian/subagent evidence and media extraction semantics. A faster first chunk must not silently omit evidence forever or publish stale enrichment over a newer revision.

Acceptance should include a controlled expensive visible preparation A, an open request B, and proof that B does not wait for all offscreen enrichment of A. Measure time to usable summary/first chunk separately from time to fully enriched history. Use a large synthetic conversation with many messages and raw events, not only many empty turns. Assert duplicate open/visible requests share required work, cancellation cannot corrupt active cache writes, and failed enrichment remains recoverable.  
Existing queue tests verify serialization and ordering. They do not establish a useful first-content latency or whether a high-priority open is held behind a long active background operation. Coordinate implementation with the frontend navigation report so a backend improvement is evaluated without a full-document navigation hiding its benefit.

## DATA-03: production live options disable the append-read path
**Source-confirmed:** the `SessionCacheUpdater` construction in `server/live/reconciler.ts:307-310` passes `retainLiveSources: false`. After normalization, `server/cache/sourceManifest.ts:534-537` deletes the in-memory source state under that option. The append decision at `sourceManifest.ts:588-595` requires `live !== undefined`, matching identity, parser version, and a larger source size. The actual live reconciler therefore cannot take `#readAppend` after its prior completed update.  
Changed sources use `#readFull`, which reads from offset zero at `sourceManifest.ts:380-384`. `#normalizeAndStore` normalizes `candidate.records` and replaces the session at lines 477-515. `server/live/reconciler.ts:812-826` automatically prepares previously ready sources whose source revision changed; that update subsequently runs DATA-02's full rich-content preparation.  
**Impact:** a long thread that is actively receiving records can repeatedly consume full-source read, normalization, cache rewrite, reconstruction, and rich-preparation work. This can delay unrelated requests. This audit did not run a real large-session append benchmark, and does not claim a particular append frequency or throughput.

### Remedy and invariants
The retention setting protects against keeping every historical source in memory, so changing it globally to `true` is not a complete fix. Choose bounded active-session state, persisted resumable parser state, or another measured strategy that supports append reads without unbounded archive memory retention. Keep source identity checks, truncation/replacement detection, partial trailing-record handling, parser-version changes, and stale-catalog commit fences.  
Append reading alone is not sufficient if the implementation still renormalizes and rerenders the entire accumulated record array. Measure and reduce the changed-turn work, and explicitly identify events that can modify earlier turns or summary/topology metadata. Preserve exact results against full normalization as the behavioral oracle.  
Acceptance must instantiate the updater through production `LiveReconciler` options. After one materialization, append complete records and record read offsets/bytes, normalized turn updates, and rich-parser invocations. Compare the resulting session with a fresh full normalization. Add truncation, replacement, same-size rewrite, incomplete final JSONL record, and changing-during-read cases. Track retained memory over repeated active-session switches to verify eviction/bounds. Tests of the updater's default configuration alone do not prove production append behavior.

## DATA-04: redundant startup passes and archive-wide work for local changes
**Source-confirmed startup path:** `server/live/reconciler.ts:933` awaits `#reconcileAll(false, false)`. Lines 939-941 schedule another full reconciliation when the watcher is ready; lines 942-944 separately schedule a fresh-state-snapshot reconciliation. Each invokes discovery, metadata loading, and catalog refresh through lines 838-846. These operations are serialized, but they are not coalesced into one follow-up.  
**Executed:** one `start()` with an empty injected discovery and an immediately ready fake watcher produced three discovery calls before any periodic tick or manual reconciliation. The following reproduces that result without reading real sources or starting a filesystem watcher:

```powershell
@'
import { createJiti } from 'jiti';
const jiti = createJiti(process.cwd() + '/');
const { openCacheDatabase } = await jiti.import('./server/cache/database.ts');
const { LiveReconciler } = await jiti.import('./server/live/reconciler.ts');
const { InvalidationBus } = await jiti.import('./server/live/invalidationBus.ts');
const database = openCacheDatabase(':memory:');
let discoveries = 0;
const reconciler = new LiveReconciler({
  database,
  bus: new InvalidationBus(),
  codexHome: 'C:/fixtures',
  cacheDir: 'C:/fixtures',
  fetchFavicons: false,
  watch: () => ({ ready: Promise.resolve(), close: async () => {} }),
  discover: async () => {
    discoveries += 1;
    return { rollouts: [], metadata: { sessionIndex: null, globalState: null, stateDatabase: null, stateWal: null }, diagnostics: [] };
  },
});
await reconciler.start();
await new Promise((resolve) => setImmediate(resolve));
console.log(JSON.stringify({ startupDiscoveryPasses: discoveries }));
await reconciler.close();
database.close();
'@ | & .\node_modules\node\bin\node.exe --input-type=module
```

Observed output: `{"startupDiscoveryPasses":3}`. This proves call duplication, not the cost of discovering the user's archive.  
**Source-confirmed ongoing path:** `server/live/reconciler.ts:849-863` updates the discovery and selected metadata from a watcher batch, but then calls `#refreshCatalog` with the entire discovery. `server/live/catalogBuilder.ts:138-143` reads all catalog records; lines 147-175 visit all discovered sources and stat every existing rollout, in batches of 32. `server/cache/catalogStore.ts:216-225` subsequently reads/parses the whole catalog again during upsert. The first pass's prefix reuse avoids transcript reads for unchanged files, but does not avoid the archive-wide observation/JSON work. Even a global-state-only or state-WAL-only event enters this full catalog refresh. The 30-second periodic reconciliation is additional work.  
**Remedy:** preserve the quick retained-state startup if it improves availability, but coalesce watcher readiness and fresh snapshot needs into a single follow-up when possible. Apply rollout watcher batches by affected path and metadata-only changes by affected records/project/topology, without restatting unchanged source files. Retain a full periodic recovery scan to catch missed events, but avoid building a backlog of redundant full passes when one is still running.  
**Invariants:** capture changes that occur during watcher startup, recover missed events, handle deletions/renames and duplicate session sources, preserve catalog metadata precedence and parent/child topology, and reject stale materialization writes. Do not trade correctness for a permanently trusted discovery snapshot.  
**Acceptance:** instrument discovery, source observations, prefix bytes, snapshot calls, catalog rows parsed, and write counts. Cover immediate and delayed watcher readiness; one changed rollout in a large catalog; metadata-only changes; changes arriving during a refresh; and periodic recovery of an intentionally missed event. A one-file event should not require one stat per archived file. The exact startup pass count can remain more than one when there is new evidence, but identical reasons must be coalesced.  
**Existing gap:** `tests/performance/liveCatalogStartup.test.ts` measures mocked fast prefix/stat calls and deliberately verifies all 500 observations on an unchanged catalog refresh. It tests prefix-read boundedness and avoided writes, not incremental watcher work or complete runtime startup pass counts.

## DATA-05: materialization events invalidate all library pages
This is a cross-owner finding. The backend owns event production; the library frontend owns selective refresh and state preservation.  
`server/live/reconciler.ts:512-516` emits `library.updated` after source preparation, and lines 569-573 emit another library update when materialization settles. `app/composables/useLibraryWorkspace.ts:495-500` handles every nonempty library update with `scheduleRefresh`, without considering which cached rows/projects are affected. `useLibraryWorkspace.ts:466-473` clears all project and child page maps and schedules a refresh with a zero-millisecond delay when not searching. `refreshExpandedProjects`, lines 476-480, refetches project initial pages but does not refill expanded child pages.  
The existing timeout can combine events that arrive before the same scheduled callback runs; it does not batch a sequence of distinct materializations separated by asynchronous work. A preparation batch can therefore drive repeated project/status/list requests. Since all page maps are cleared, previously loaded pages beyond the first 20 disappear and expanded child data is lost. Browser behavior was not exercised during this audit, so visual flicker and exact request multiplicity remain to be measured.  
**Remedy:** reduce redundant backend notifications or make their semantics distinguish row materialization from structural library changes. Update affected row materialization/summary state in place; refresh only affected project/parent scopes when ordering/counts actually change. Preserve loaded extent, scroll position, and expanded child data. Coalesce bursts with a measured debounce. Use request-generation checks/cancellation when a refresh can race with filters or navigation.  
**Acceptance:** begin with two expanded projects, load a second page, and expand a parent thread. Materialize an unrelated session and assert that loaded pages, child rows, and expansion remain. Materialize 20 visible sessions and bound network request counts. Update a session's ordering metadata and ensure the affected list changes correctly without stale duplicates. Cover switching filters while old refreshes resolve. Coordinate with the frontend owner before changing public invalidation event semantics.

## DATA-06: live navigator preview differs from final-answer semantics
`server/cache/repositoryStore.ts:130-134`, `createTurnNavigatorItem`, selects the message matching `finalAssistantMessageId`, falling back to the last assistant message. `getCachedTurnNavigator` instead reads all message markdown at lines 149-166 and sets `draft.assistant` only while it is empty at lines 206-207. Ordered by message insertion, this retains the first nonempty assistant message, commonly initial commentary. The preview is emitted at line 216.  
This is a functional live/static mismatch even when performance is acceptable. The query also reads complete message markdown for every turn to produce short previews and prose-length buckets. That is narrower than DATA-01's full rich/raw reconstruction, but still grows with all message text whenever the navigator is requested.  
**Remedy:** use the same final-message selection contract in both modes. Consider storing compact navigator records during normalization, including preview strings and length buckets, so reads scale with compact navigation metadata. If a migration is needed, design invalidation/backfill explicitly and avoid reconstructing all raw events to populate navigator previews.  
**Acceptance:** construct a turn with initial commentary, multiple assistant messages, and a distinct explicitly selected final message; compare live navigator output to `createTurnNavigatorItem`. Also cover no final ID, no assistant messages, empty commentary, steering messages, and a final ID that is not the last inserted assistant. Require parity for preview and length bucket. Query-volume tests should verify that compact navigator reads do not retrieve unrelated raw-event payloads or all rich turn payloads.

## Verification boundaries and implementation handoff
Executed in this audit: the actual-reconciler warm-read SQL/timing probe and injected empty-source startup discovery-count probe. Source inspection established all other call chains. No source implementation was changed, no tests were added, and no full release/test suite was run for this report-only work. No browser performance recording, cold full-session benchmark, or real archive append benchmark was performed.  
Before claiming the loading issue fixed, combine deterministic backend guards with the frontend owner's navigation/history acceptance. Record cold versus warm API latency, time to first usable thread content, later-history request time, event-loop delay during active ingestion, and counts of unnecessary reloads. Keep the underlying input archive read-only and use controlled fixtures for destructive/replacement scenarios.  
Do not use passing direct-store microbenchmarks as evidence of end-to-end live performance. The regression in DATA-01 survived exactly that separation between the tested helper and the production call path.
