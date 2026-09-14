# Subagent topology, catalog, and navigation audit
Date: 2026-09-14. Source baseline supplied by the coordinating audit: `a7765ac`. Scope: read-only investigation of session metadata, catalog topology, normalized summaries, sidebar child loading, and related search/export behavior. This document is the only artifact authored by this audit; no implementation or Git changes were made.  
The reported standalone-subagent behavior has a confirmed source-level cause and a reproduction against current local metadata. The catalog reads only 4,096 bytes by default, but sampled current ordinary subagent metadata records are approximately 22.5 KiB. The prefix reader consequently returns no parsed metadata, and ordinary child classification ignores the parent hint that the same reader successfully extracted. Optional SQLite spawn edges can conceal this defect; their absence exposes it. Three additional confirmed defects affect recovery and visibility after a relationship is correctly discovered.
## Evidence boundaries
- Executed three narrow reproductions using the actual TypeScript functions: current bounded metadata classification, orphan recovery across two in-memory refreshes, and cross-project child listing against an in-memory catalog.
- Sampled eight ordinary child rollout metadata records from one current date. Their first-record lengths were 22,547–22,581 bytes. No archive-wide percentage or historical prevalence is claimed.
- Printed only selected structural metadata and aggregate results during investigation. This report omits real session identifiers, real agent names, transcript text, and private source paths.
- Read files with sharing compatible with an active Codex writer. An initial ordinary text-reader attempt encountered Windows sharing errors; the corrected read used read access with `ReadWrite | Delete` sharing and a fixed 65,536-byte buffer. No source file was modified or locked against the writer.
- Verified the expanded-child invalidation defect by tracing the complete Vue state/render path. No browser reproduction or screenshot acceptance was performed for that defect.
- Existing tests were inspected for coverage; this audit did not run the complete test suite, build, export, or archive-wide search indexing.
- The coordinating report owns screenshot-specific visual requirements and broader tool/timeline rendering. The parent lifecycle and optional child-view requirements below define the topology-dependent behavior that those implementations need.
## Findings and implementation order
| ID | Priority | Confirmed problem | Evidence | Recommended order |
| --- | --- | --- | --- | --- |
| TOP-01 | P1 | Oversized ordinary subagent metadata becomes a root without optional spawn-edge enrichment | Executed with current metadata and actual prefix/classifier functions | First, together with original-evidence persistence |
| TOP-02 | P2 | An orphan promoted to root never reattaches when its unchanged source is reused | Executed two-refresh reproduction using existing fixtures | Same foundational change as TOP-01 |
| TOP-03 | P2 | Child queries inherit the parent project and omit valid children with different project identities | Executed real catalog filtering using existing fixtures | After classification is reliable |
| TOP-04 | P2 | Library refresh clears child pages while retaining expansion state, leaving empty expanded branches | Complete source/render-path confirmation | After child query semantics are fixed |
Implementing only a visual grouping change would leave TOP-01 and TOP-02 intact. Implementing only a parser change can leave previously cached roots intact. The first delivery should establish a correct reusable relationship model and its cache migration/reclassification behavior; the next should make that model consistently visible.
## End-to-end source map
| Stage | Authoritative implementation | Behavior relevant to the defect |
| --- | --- | --- |
| Prefix budget | `server/ingestion/selectSessionSources.ts:17`, `:82` | Default budget is 4,096 bytes; each rollout prefix uses this limit unless explicitly overridden |
| Complete-record parser | `server/ingestion/sessionMetaPrefix.ts:129`–174 | Only complete newline-terminated records are parsed; no newline within the budget yields null metadata |
| Parent hint | `server/ingestion/sessionMetaPrefix.ts:178`–190, `:218`–220 | Extracts an early parent field even when the complete metadata record is unavailable |
| Classification | `server/live/catalogBuilder.ts:201`–234 | Recognizes nested `source.subagent.thread_spawn`; parent hints are used only in the auxiliary branch |
| Optional thread enrichment | `server/live/catalogBuilder.ts:488`–495 | Looks up a SQLite thread, passes its model, but does not pass its source string to classification |
| Optional relationship enrichment | `server/live/catalogBuilder.ts:380`–390 | Applies SQLite spawn edges where the derived parent is still null |
| Orphan and cycle presentation | `server/live/catalogBuilder.ts:392`–417 | Clears effective parents for missing ancestors and cycle members; ordinary rows become roots |
| Child counts and summaries | `server/live/catalogBuilder.ts:419`–448 | Derives child lists/counts from catalog relationships and copies them into summaries |
| Unchanged-prefix reuse | `server/live/catalogBuilder.ts:91`–131 | Reconstructs metadata from derived catalog kind/parent rather than original source evidence |
| Independent project resolution | `server/live/catalogBuilder.ts:508`–511; `shared/library/projectIdentity.ts` | Resolves each live row from its own cwd/Git metadata and optional saved projects |
| Full normalization | `server/normalization/normalizeSession.ts:198`–230, `:1295`–1306 | Reads top-level parent/fork evidence and merges optional metadata |
| Materialization overlay | `server/cache/catalogStore.ts:484`–489 | Preserves existing catalog parent and children over the normalized summary |
| Served session overlay | `server/live/repository.ts:104`–117 | Returns catalog topology even when the parsed session summary has other parent evidence |
| List repository | `server/live/repository.ts:70`–71 | Delegates directly to catalog listing |
| SQL placement filters | `server/cache/catalogStore.ts:287`–325 | Applies scope/project and root-or-child restrictions plus content filters |
| Child request | `app/composables/useLibraryWorkspace.ts:303`–325 | Requests children using the parent's project plus the current list filters |
| Expanded child render | `app/components/library/LibrarySessionTree.vue:15`–16, `:43`–66 | Renders the saved page for an expanded parent; absent page means an empty child list |
| Refresh invalidation | `app/composables/useLibraryWorkspace.ts:466`–480 | Clears project and child pages, then reloads expanded projects only |
The common sidebar root list is not independently inventing a hierarchy: `listCatalogSessions` requires `session_kind = 'root'` and a null parent for root queries. A mistakenly classified row therefore reaches the UI as an ordinary root by design.
## TOP-01: Oversized ordinary child metadata is classified as a root
### Trigger and actual failure
The current first metadata record can include enough additional data to exceed the 4,096-byte startup prefix, even though the structural fields occur near the beginning. `parseCompleteLines` requires a newline before parsing any metadata. A complete 22.5 KiB first record therefore appears indistinguishable from missing metadata to the cold classifier when the budget is 4 KiB.  
`readSessionMetaPrefix` still extracts a non-null `parentThreadIdHint`. However, `classifySessionMeta` considers the hint only when it already knows the session is auxiliary through guardian metadata or `codex-auto-review`. For an ordinary child, null metadata bypasses the nested spawn branch and returns a root with a null parent. The classifier also ignores a top-level parent on otherwise parsed metadata when nested spawn data is absent.  
SQLite spawn edges can repair the derived parent in `applyTopology`. They are optional enrichment and cannot be assumed present or complete. The current metadata snapshot already reads a thread `source` string, but catalog classification does not consume it. This explains why fixture tests with small records or complete spawn-edge snapshots can pass while the real-source path fails.
### Executed reproduction and result
The audit read a bounded current ordinary child metadata prefix with the actual `readSessionMetaPrefix(path, 4096)`, then passed its result to the actual `classifySessionMeta(prefix.meta, null, prefix.parentThreadIdHint)`. The sampled source's complete first record was 22,547 bytes; its parent field started at character 181 and its source field at character 396.  
Observed result, with the real identifier removed:
```json
{"status":"missing","parentHintPresent":true,"classification":{"kind":"root","parentThreadId":null,"agentPath":null,"agentNickname":null,"agentDepth":null}}
```
The eight sampled ordinary children from the same date all had metadata records larger than the default budget. This confirms a current input/implementation mismatch; it does not establish the current on-disk catalog state for every sampled session.
### Why opening the child does not repair the display
Full normalization can recover top-level `parent_thread_id` from the complete session. Nevertheless, `markCatalogSessionReady` preserves the pre-existing catalog relationship over that summary, and `LiveConversationRepository.getSession` overlays it again. Repair must happen in the catalog evidence/classification path, with a deliberate policy for reconciling later authoritative evidence. Merely adding another normalized-summary field or reloading the opened view will not repair the cold catalog.
### Required change
- Keep metadata acquisition bounded, but distinguish budget exhaustion from genuinely missing/invalid metadata. A useful operational diagnostic must not imply that an ordinary oversized record is malformed.
- Choose one concrete parser strategy: extend reading through the first metadata record up to a documented cap, or implement token-aware selected-field extraction that can skip large string values without reading transcript bodies. Avoid a general unbounded full-session fallback during catalog startup.
- Treat source kind, declared parent, agent path, nickname, and declared depth as structural evidence. Preserve their provenance and whether extraction is complete, rather than storing only an effective root/child decision.
- Use optional parsed SQLite source as a fallback when rollout evidence is unavailable. Define conflict precedence once and reuse it in catalog and full normalization. Do not let an optional stale edge silently replace a validated conflicting rollout parent.
- Keep guardian exclusion intact when only model or source evidence is available. A generic parent hint alone is insufficient to distinguish every relationship kind.
- Include existing cached entries in the repair. Reusable synthetic prefixes can otherwise bypass the new reader; require an evidence/parser version transition that forces structural reclassification of affected entries.
### Invariants and acceptance
- A recognized child with an available parent appears beneath that parent with no SQLite database available.
- Small and large metadata representations of the same structural evidence produce identical topology.
- Missing optional SQLite enrichment never turns validated rollout child evidence into a root.
- Cold, materialized, and repeated unchanged refreshes converge on the same relationship.
- Budget exhaustion, incomplete trailing records, malformed data, and genuine root metadata remain distinct cases with bounded work.
- The fix does not normalize every transcript during startup and does not mutate Codex source files.
## TOP-02: Orphan promotion destroys reusable evidence
### Trigger and actual failure
When a child is discovered before its parent, `applyTopology` intentionally makes the child visible as a root. It also clears the only parent stored in the catalog row. On the next unchanged refresh, `cachedSessionSource` synthesizes a root metadata object from that row. The original declared parent is gone, so discovering the parent later does not restore the relationship.  
This is different from the initial orphan policy: visible fallback is useful, but it must be reversible. The same evidence-loss pattern can affect cycle recovery because cycle handling also clears effective parents before subsequent cache reuse.
### Executed reproduction and result
Using `openCacheDatabase(':memory:')`, existing `tests/fixtures/catalog/subagent.jsonl` and `root.jsonl`, empty optional global projects, no session index, and no SQLite snapshot:
1. Refresh with only the child fixture.
2. Refresh the same database with the parent fixture and the unchanged child fixture.
3. Compare returned kind/parent fields.
```json
{"first":[{"id":"child","kind":"root","parent":null}],"second":[{"id":"root","kind":"root","parent":null},{"id":"child","kind":"root","parent":null}]}
```
The second result should contain `child` as a subagent of `root`. Both fixtures are unchanged repository files; no temporary source edits were required.
### Required change
- Separate declared source relationship from effective display placement. A row may be displayed among roots because its parent is unavailable while still retaining `declaredParentId` and source classification.
- Recompute effective topology from preserved original evidence and current discovery on each topology refresh. Do not reconstruct source evidence from the already-reconciled result.
- Preserve the same distinction for cycle rejection; diagnostics should explain rejected effective edges without erasing the underlying observation needed for later recovery.
- Derive parent summaries, child lists, counts, and depths in one pass after effective topology is resolved, so updates include all affected rows.
- Decide how a missing/temporarily changing parent is presented without creating a permanent orphan. The existing visible fallback can remain, but must be re-evaluated.
### Invariants and acceptance
- Child-first discovery followed by parent discovery reattaches the unchanged child.
- Parent removal makes the child visible according to the orphan policy, and parent return restores nesting without touching the child file.
- Repeated unchanged refreshes are idempotent and retain original evidence.
- A repaired cycle can become an ordinary relationship after corrected source/edge evidence is observed; cycle rejection does not create permanent synthetic roots.
- Cached original evidence and effective summaries remain separately versioned or invalidated when their meaning changes.
## TOP-03: Child listing incorrectly inherits project identity
### Trigger and actual failure
Live catalog projects are resolved independently per session. A child working in a different repository may legitimately resolve to a different project. The same difference can arise when the root has Git metadata but the child has only a cwd and saved project definitions are unavailable. `loadChildren` still adds `projectId: parent.projectId`; the SQL combines this with the child-parent predicate. A valid linked child is excluded.  
The parent `childCount` comes from the relationship graph, without that project filter. The UI can therefore offer expansion for a parent with one known child and return an empty page. The child also does not become a root of its own project, because catalog root queries exclude subagents. This is a visibility loss, not simply an alternative grouping.
### Executed reproduction and result
Build a fresh in-memory catalog from the unmodified root and child fixtures with empty optional global projects and no SQLite snapshot. The root resolves from its Git origin and the child from its cwd. Query direct children once with the root project and once without it.
```json
{"rootChildCount":1,"rootProjectSource":"git","childProjectSource":"cwd","childrenWithParentProject":0,"childrenWithoutProjectConstraint":1}
```
### Required change and live/static distinction
Remove the inherited project restriction from direct relationship queries, or introduce a separate explicit tree-group identity and use it consistently. The simpler targeted correction is to use projects for root grouping and parent identity for child expansion. Preserve each child's actual cwd/Git/project metadata for inspection.  
Static export already follows a different policy: `server/export/writeStaticPayloads.ts:420`–433 walks ancestors to choose a child's tree project, then writes that inherited project at lines 456–469. Live uses each row's independently resolved project. Do not accidentally “fix” the bug by overwriting original child provenance. Define which field represents sidebar placement and verify both modes against the same intended behavior.
### Filter and scope follow-up
`loadChildren` also inherits the current scope, model, cwd, tool, and media predicates from `listQuery`. A parent and child can differ on these fields; `childCount` still counts all known direct child relationships. This is a confirmed semantic mismatch in how the inputs are combined, but the preferred scope/filter behavior is a product decision rather than an automatically prescribed defect fix.  
Recommended contract: root filters choose conversation trees, while explicitly revealing a tree displays its children with their own metadata and clear match/scope context. If descendants are intentionally filtered instead, show an explicit filtered/total state and provide a way to reveal hidden children. Cross-scope descendants must remain discoverable; do not leave an expandable branch silently empty.
### Invariants and acceptance
- A child in another project remains reachable through its parent.
- A parent's expansion count and returned child visibility agree, or the UI explicitly states why some children are filtered.
- Actual project/cwd provenance remains inspectable and is not rewritten merely to satisfy sidebar grouping.
- Live and static navigation follow the same documented tree-placement rule.
- Root pagination still counts roots only; showing children does not inflate project root counts.
## TOP-04: Expanded child pages disappear after refresh
### Trigger and actual failure
`scheduleRefresh` clears both page maps and leaves expansion sets intact. `refreshExpandedProjects` refreshes the root payload and expanded project pages, but never reloads expanded child pages. `LibrarySessionTree` has computed accessors for the expansion flag and page; it has no watcher or mount effect that fetches a missing expanded page. Its `v-for` falls back to an empty array.  
The resulting branch remains expanded with an open caret and empty contents. Clicking once collapses it; clicking again reaches `toggleSession`'s load branch and restores the children. The user should not need that manual recovery after an ordinary library invalidation.
### Required change
- Refresh or invalidate expanded child pages coherently with their expansion state. Either explicitly reload reachable expanded parents after project rows arrive, or make an expanded missing page trigger one deduplicated fetch.
- Preserve nested expansions in dependency order: the root's page must make a nested expanded parent reachable before its children are reloaded.
- Fence requests by refresh generation or an equivalent mechanism so an older child response cannot repopulate a newer scope/filter state.
- Deduplicate concurrent reloads and preserve existing bounded pagination. A refresh should not eagerly traverse every closed branch.
- Show a loading or recoverable error state while an expanded branch is unresolved; do not render silent emptiness for a known loading/error condition.
- Coordinate this with the broader workspace request-race work owned by the main audit rather than introducing a second competing cancellation mechanism.
### Invariants and acceptance
- Expanding a parent, receiving a library invalidation, and completing refresh leaves that subtree visible without manual toggling.
- A two-level expanded hierarchy reloads both reachable levels.
- Closed branches remain lazy and produce no extra child requests.
- A stale request cannot overwrite the latest scope/filter generation.
- A child reload failure is visible and retryable, and retry does not collapse the parent.
## Parent lifecycle and optional child-view contract
Correct topology must support two complementary views of the same work. The parent conversation should retain subagent lifecycle activity at the correct chronological position, including spawn/start, meaningful progress or waiting state, completion/failure/cancellation, and the reported result where source evidence provides it. That lifecycle must identify the same child that appears in navigation; it should not render the child as an unrelated top-level conversation.  
The child can remain independently inspectable through an explicit open-child action, nested sidebar item, or separate child-view option. The child view should preserve a parent breadcrumb/link and a clear child identity. Opening it must not promote it into the ordinary root list. Orphan fallback should explain the unavailable parent while preserving original relationship evidence.  
Avoid copying the complete child transcript into the parent's normal prose flow merely to show that the child exists. Parent lifecycle and child transcript inspection serve different reading tasks. Exact visual treatment, wording, and screenshot fidelity belong to the coordinating visual/timeline report; the acceptance requirements here concern relationship identity, chronology, reachability, and synchronization.  
`server/normalization/subagentTopology.ts:45`–68 currently enriches lifecycle activities by explicit child ID, or by an agent path only when that path identifies exactly one candidate. Preserve the explicit-ID preference and ambiguity check. Agent paths are not globally unique across unrelated conversations; future scoping should use the parent relationship rather than guessing from an ambiguous path.
## Search, normalization, and export alignment
### Search behavior that must be made explicit
The workspace's `searchQuery` inherits `parentThreadId: '__root__'` from `listQuery` at `app/composables/useLibraryWorkspace.ts:144`–159. However, `server/cache/searchStore.ts:173`–204 builds filters for scope, project, model, cwd, tool, and media without applying a parent predicate. Full-text search joins normalized sessions rather than using the catalog root-list predicate. A child search hit can therefore appear even when the ordinary root list is correctly nested. This is source-confirmed behavior; no claim is made that every child is currently indexed or returned.  
Do not use a flat search hit as evidence that sidebar topology was recovered. Choose and document search presentation separately: a child match should either be grouped with its parent or carry clear child/parent context and a direct navigation target. It should not silently imply that a subagent is a root conversation. Align deep-search candidate selection, result counts, and result rendering with that decision in the search-focused implementation.  
Add a regression containing a term unique to child content. It must remain discoverable under the chosen contract and open the correct child/turn, while preserving parent context. Test this with both warm indexed children and whichever cold/deep-search behavior the search implementation promises.
### Relationship semantics requiring a source-reference decision
Full normalization assigns `parent_thread_id` and `forked_from_id` to the same summary parent field at `server/normalization/normalizeSession.ts:222`–225. The cold classifier instead recognizes nested spawn metadata. A user-created fork and a delegated child are different concepts and should not be merged without checking the current Codex source contract. Treat this as an unresolved semantic alignment task for the reference audit, not an additional executed defect claim.  
After the contract is verified, share extraction/classification logic between cold catalog, full normalization, static reconciliation, and lifecycle enrichment. Keep explicit fork lineage separate from delegated-child placement if the source contract requires it. Test precedence/conflicts rather than relying only on one synthetic happy-path shape.
### Export implications
Static reconciliation at `server/export/writeStaticPayloads.ts:383`–408 repairs missing parents/cycles from normalized summaries and reconstructs child lists. It does not use the same cold prefix classification path as live catalog. Static library entries also currently write null agent paths and nicknames at lines 470–471. Therefore live and static can differ in both topology and child labels.  
Do not broaden the initial fix into a full archive export. Use representative fixtures to prove shared relationship semantics and preserved child identity. If labels are added to the shared normalized contract, version the exported payload and update schema verification and static consumer tests together.
## Regression plan and test gaps
| Case | Existing evidence/test gap | Discriminating assertion | Suggested location |
| --- | --- | --- | --- |
| Large ordinary child record | Prefix tests check an oversized parent hint; large catalog test covers auto-review only | >4 KiB record with available parent and no state snapshot becomes a child | `tests/unit/ingestion/sessionMetaPrefix.test.ts`; `tests/unit/live/catalogBuilder.test.ts` |
| Current-size metadata shape | Existing catalog fixture is tiny | Synthetic 22–24 KiB metadata record preserves topology with structural fields before padding | Same tests; no real transcripts in fixtures |
| Structural field after padding | Early hint success can mask a parser limit | Either supported extraction succeeds or explicit bounded unresolved state is returned; no false root claim | Prefix tests |
| Incomplete metadata write | Budget exhaustion and incomplete record are distinct | Retry on completion resolves metadata without reading arbitrary transcript bodies | Prefix/catalog tests |
| Orphan parent arrives | Existing orphan test checks only initial promotion | Second unchanged refresh reattaches child | `tests/unit/live/catalogBuilder.test.ts:377` onward |
| Parent disappears and returns | No proof in the reviewed orphan test | Reversible effective placement preserves declared relationship | Catalog builder tests |
| Cached misclassification upgrade | Synthetic cached source can bypass parser | Version transition revisits old root entries and repairs parent/children/counts | Cache/catalog tests |
| Materialization after cold parse | Ready overlay can preserve incorrect topology | Cold and opened summaries agree after repair; correct later evidence reconciles intentionally | Catalog store/live repository tests |
| Different child project | Existing UI fetch mock returns child solely from parent ID | Real filtering returns child through parent regardless of its direct project | `tests/unit/ui/libraryProjectTree.test.ts`; catalog tests |
| Expanded branch invalidation | Existing tree test exercises initial expansion only | Invalidation preserves/reloads visible child and grandchild without manual toggles | Workspace/tree tests |
| Stale child response | Child fetching must share workspace race control | Old-scope result cannot replace new-scope branch | Workspace tests with deferred promises |
| Filtered/cross-scope descendants | Counts and page filters differ | Chosen filtered/reveal behavior is explicit and child remains reachable | Workspace and repository contract tests |
| Child-only search term | Search predicates differ from root-list predicates | Hit retains child/parent context and opens correct target | Search/repository/UI tests |
| Fork versus spawn | Normalizers use different evidence | Verified source semantics produce the intended distinct relationship types | Normalization/catalog/export tests |
| Live/static parity | Static inherits tree project; live resolves each row | Equivalent fixture corpus produces intended tree placement, identity, and parent navigation in both modes | Export/static repository tests |
The existing UI test at `tests/unit/ui/libraryProjectTree.test.ts:86`–145 proves initial root pagination and disclosure against a fetch mock. The mock returns the child whenever `parentThreadId` matches and does not enforce the project parameter, so it cannot detect TOP-03. It also performs no post-expansion invalidation, so it cannot detect TOP-04. Extend it with behavior that fails on the current implementation rather than adding snapshots of the existing markup.
## Implementation slices and dependencies
1. Define the structural evidence contract and verified fork/spawn semantics. Keep original evidence, effective placement, and display metadata distinct. Confirm cache version/migration behavior before introducing fields.
2. Repair bounded metadata extraction and optional fallback classification. Add the large-record regression first and demonstrate it fails against the baseline. Preserve guardian exclusion and incomplete-write behavior.
3. Repair cache reuse and topology recomputation. Add child-first/parent-later and migration regressions. Recompute affected parents/counts and publish topology changes through the existing invalidation path.
4. Reconcile full normalization/materialization overlays with the same authority rules. Prove that opening a session neither destroys valid catalog evidence nor permanently blocks later authoritative correction.
5. Repair child query placement and define descendant filter/scope policy. Align live/static tree grouping without rewriting the child's actual project provenance.
6. Repair expanded-child refresh using the shared workspace request-generation mechanism. Cover nested expansion, stale responses, lazy closed branches, and retryable errors.
7. Integrate parent lifecycle identity and optional child-view navigation with the timeline/content work. Add parent-context search presentation under the chosen search contract.
8. Run focused regression suites and repository-required source checks appropriate to the final patch. Perform a browser acceptance pass on representative fixture data and a bounded local-metadata smoke, recording exactly what was exercised. Do not claim archive-wide correctness from the sample or relaunch expensive full-archive indexing as part of this bounded fix.
## Review and completion checklist
- All four confirmed failures have regression coverage that exercises the failing branch or behavior, not only a mocked successful response.
- The large-record fix works without optional SQLite metadata and does not rely on increasing a magic constant alone without documenting its bounded fallback behavior.
- Original parent evidence survives orphan/cycle display reconciliation and unchanged-source reuse.
- Existing cached misclassifications have an explicit recovery path.
- Root lists, child counts, opened summaries, parent lifecycle links, and nested navigation refer to the same effective graph.
- Children remain reachable when their actual project differs from their parent's tree grouping.
- Refreshing the library does not strand expanded branches or admit stale responses.
- Search presentation distinguishes child hits from root conversations and preserves direct navigation to the matched content.
- Fork/source semantics and descendant scope/filter policy are written down before they become hidden implementation assumptions.
- Live/static differences introduced or resolved by the patch are covered with representative export/consumer checks.
- Verification reporting distinguishes executed unit/in-memory checks, browser acceptance, and any remaining native/real-corpus limitations.
## Thought candidates for the coordinating audit
- Cold catalog topology currently overrides fully parsed session metadata in both materialization and serving paths. Parser correctness alone is not enough to repair user-visible topology.
- Reusable caches should store original relationship evidence separately from the effective visible graph; orphan promotion is a reversible display decision.
- Current metadata records can be approximately 22.5 KiB while useful relationship fields occur near the beginning. Small metadata fixtures systematically miss the 4 KiB startup boundary.
- Child project provenance and tree placement are distinct concepts. Live/static consistency should not be achieved by overwriting the child's actual working-directory identity.
