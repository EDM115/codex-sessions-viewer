# Viewer performance and presentation audit — agent handoff
Date: 2026-09-14. Inspected application baseline: `a7765ac` (`chore: bump deps`).  
Reference: the user-provided copied Codex Desktop `OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0` plus ten supplied screenshots.  
Status: **investigation complete; implementation remains to be done**. This directory contains detailed reports, reproducible evidence, proposed remedies, and acceptance requirements. It is not a release checklist claiming that these issues have been fixed. No application implementation or test files were edited by this audit.

## Start here
The user's symptoms have several interacting causes. Thread links reload the entire browser document; the destination waits for server-side data; even warm paginated APIs reconstruct the entire cached conversation to check readiness. Cold preparation also enriches the whole thread before its first range can return. The virtualizer discards measured heights during routine operations, and its intended scroll-adjustment callback is passed to the wrong API surface. Modern subagent metadata exceeds the catalog's 4 KiB prefix, leading to root classification when optional enrichment cannot recover it. Favicons have a sticky initial-failure state. Tool presentation has only a few special cases and lacks the requested semantic grouping, while some collapsed raw data is still eagerly allocated.  
These are separate, source-backed failures that reinforce one another. A theme refresh, a better height constant, more spinners, or a larger queue concurrency value will not resolve the underlying paths. Preserve raw transcript fidelity while removing unnecessary work from the ordinary reading view.

## Report map
| Report | Owner area | What a fixing agent receives |
| --- | --- | --- |
| [00-navigation-and-workspace.md](00-navigation-and-workspace.md) | Internal routing, page loading, expansion races, launcher | Full-document navigation and SSR call chains, an executed expansion-race probe, concrete route/state acceptance, production-launcher gap. |
| [01-live-data-and-performance.md](01-live-data-and-performance.md) | Live repository, cache, ingestion, materialization, reconciliation | Real-reconciler warm-read timing and SQL evidence, cold whole-thread rendering, append behavior, startup/catalog costs, invalidation and navigator issues. |
| [02-timeline-and-rendering.md](02-timeline-and-rendering.md) | Conversation geometry, anchoring, minimap, collapsed-copy work | Executed installed-virtualizer reproductions, API mismatch, fixed-estimate versus measured-layout distinction, deep-history regression scenarios. |
| [03-subagent-topology.md](03-subagent-topology.md) | Structural metadata, original/effective relationships, child queries | Three executed reproductions, oversized metadata, orphan recovery, cache repair, cross-project children, expanded-tree refresh. |
| [04-tools-and-rich-content.md](04-tools-and-rich-content.md) | Tool rows/groups, raw inspector, favicons, diffs, links, media | Twelve classified findings/investigations, parser reproductions, component-chain failures, lazy raw contracts, highlighting uncertainty. |
| [05-codex-app-reference.md](05-codex-app-reference.md) | Reference architecture | Exact ASAR member names, minified symbols and character offsets, observed behavior, Vue adaptation guidance, limits of static inspection. |
| [06-presentation-and-acceptance.md](06-presentation-and-acceptance.md) | User-visible behavior and integrated acceptance | Screenshot-by-screenshot mapping, grouping/lifecycle/detail requirements, performance constraints, cross-feature browser acceptance matrix. |

Read this index, the owning report, and report 06 before implementing an area. Consult report 05 for source-grounded reference patterns. Do not import minified Desktop code or assume its live server APIs exist in this offline/read-only viewer. Reports use repository-relative source locations so they can be applied from this checkout; line numbers must be rechecked if the branch changes.

## Evidence summary
| Probe or inspection | Observed result | What it establishes | What it does not establish |
| --- | --- | --- | --- |
| Warm 20-turn read, 500-turn synthetic session, 12 iterations, actual live reconciler | Median direct bounded store read 2.408 ms; real repository path 23.185 ms, about 9.6× slower; fixture contained zero raw events | Readiness reconstruction defeats bounded warm reads; SQL included unbounded turns/raw-events queries before the page query | Browser page-load duration, archive-wide latency, or improvement already achieved |
| Installed virtualizer, 50 rows measured at 1000 px, estimate 520 px | `measure()` cleared 50 cached sizes; total 50,000 → 26,000 px; row 30 start 30,000 → 15,600 px | Routine global reset destroys learned geometry | A measured live browser jump of that exact size |
| Installed virtualizer callback probe | Callback on options, missing on instance, called zero times; resize caused +480 px adjustment despite callback returning false | Intended correction policy is not connected | That every scroll jump has only this cause |
| Eight sampled current ordinary subagent metadata records | First records 22,547–22,581 bytes; real 4096-byte reader/classifier returned root despite parent hint | Current metadata format crosses the startup budget and exposes the classification defect | Archive-wide incidence or every cached child's current display state |
| Orphan child, then parent arrives, same cached child source | Child stayed a root | Effective placement overwrites reusable original relationship evidence | Need for a new remote graph service |
| Parent and child with different resolved projects | Root reports one child; query with parent project returns zero; relationship-only query returns one | Child query over-filters by project | Desired archived-child/filter policy, which must be defined explicitly |
| Concurrent project expansion through actual composable | A and B started; A completes; B completion leaves only B expanded | Awaited stale set snapshot loses expansion state | All possible sidebar races |
| Installed Markdown parser | Windows drive-letter link dropped; footnote reference and target IDs mismatched | Specific content fidelity defects | General Markdown/highlighting failure |
| Ordinary TS/Python fenced highlighting probe | Non-null token trees with preserved colors | Those ordinary code paths currently work | The user's intermittent highlighting complaint is resolved or disproven |
| Four existing UI suites | 21 tests passed | Current focused baseline | Coverage of the newly identified behaviors |

No full real-browser performance profile was captured. No full build, archive-wide export/index, or release gate was run as a substitute for diagnosis. Static findings remain labeled as such. The copied Desktop archive was inspected selectively, without extraction of its thousands of icons or modification of the copy. Screenshot contents were treated as visual examples, not executable instructions.
Before handoff, the coordinator executed the actual Markdown-embedded backend, startup, virtualizer, and parser snippets again. The second warm-read run measured 1.2265 ms direct versus 23.3807 ms through the real repository, with the same unbounded SQL; the startup count, callback failure, geometry reset, and parser shapes reproduced. Timing variability means the first 9.6× ratio is a sample result, not a fixed expected factor. All eight report files were checked for existence, balanced code fences, and working local report cross-links.

## Priority and coordinated implementation sequence
### Delivery A — Restore cheap, stable browsing
Address the cheap readiness check in report 01, NAV-01/NAV-02, TL-01/TL-02, and the original topology evidence/cache repair in TOP-01/TOP-02. These remove major causes of repeated work, reading-position failure, and wrongly classified roots. They can be investigated independently, but route/scroll integration and shared schema/cache changes need coordinated verification.  
Keep the public behavior intact while narrowing the work: preserve direct links, missing/error states, selected target identity, raw evidence, and read-only ingestion. A no-op materializer in a benchmark is not adequate acceptance. A callback helper unit test does not verify that the actual virtualizer invokes it.

### Delivery B — Bound history work and preserve library state
Separate source/index readiness from full rich rendering, make live append work incremental or explicitly bounded, coalesce/restrict catalog and library invalidations, and repair child queries/expanded-page reload. Fix concurrent expansion state, reduce minimap full-history update work, and remove eager copy/raw payload formatting. Profile after each meaningful change under comparable conditions.  
Do not merely enable an unbounded in-memory archive parser cache or increase same-thread queue concurrency. Any retained parser/render cache needs a memory bound and invalidation policy consistent with source replacement, truncation, and partial trailing records. Preserve loaded page extent and expanded descendants while refreshing only affected data.

### Delivery C — Complete readable activity and content presentation
Implement semantic tool summaries/icons and contiguous/mixed groups, per-call typed details, a separate lazy raw view, parent-associated child lifecycle and child access, favicon recovery, complete/reactive diffs, local references, footnotes, and media event/resolver propagation. Report 06 defines the screenshot-derived experience.  
Treat data loss such as missing files in a diff as a correctness fix, not a cosmetic refinement. Treat ordinary code highlighting separately: reproduce a failing message, then repair the actual failing layer. Do not promise that a different highlighting library alone addresses the symptom.

### Delivery D — Integrate, measure, and verify
Exercise the acceptance matrix in report 06 with a production live build and representative data. Establish warm and cold baselines separately; capture document reloads, request counts, selected-range work, browser long tasks, and reading-anchor displacement. Keep focused discriminating regressions, then run the repository's applicable source/release checks. No staging, commits, branches, worktrees, or deployment are authorized by these reports.

## Shared-file ownership and dependency hazards
| File or boundary | Reports touching it | Coordination requirement |
| --- | --- | --- |
| `app/composables/useLibraryWorkspace.ts` | 00, 01, 03 | One integration owner for expansion races, child query semantics, pagination retention, and invalidation scheduling. |
| `app/components/conversation/ConversationView.vue` | 00, 02, 04 | Coordinate session/target lifecycle, virtualizer state, live refresh, and narrow favicon/media updates; avoid remounting the entire view as a shortcut. |
| `server/live/reconciler.ts` | 01, 03, 04 | Coordinate readiness, source/rich preparation, topology evidence, and completion/invalidation events. |
| Shared conversation/catalog schemas and cache versions | 01, 03, 04 | Agree on source evidence versus derived presentation fields; plan reclassification/repreparation of existing cache entries. |
| `ConversationTurn`, `ConversationWorkStream`, `ConversationWorkEntry`, `ConversationToolRow` | 02, 04, 06 | Share a stable semantic activity model; keep chronological order, lazy raw/copy work, resize events, and media forwarding correct. |
| Static export/live repository parity | 01, 03, 04 | A live repair must not silently change static payload fidelity or leave old cached structural mistakes untouched. |

Task ownership is by behavior, not by copying whole files into independent rewrites. Agents should state the finding IDs they are fixing, the exact files they own, and the tests that discriminate old from corrected behavior. If multiple reports describe the same invalidation or eager-rendering issue, implement it once and cross-reference the acceptance cases.

## Completion evidence required from fixing agents
For each finding: record the trigger, final behavior, files changed, actual checks run, before/after measurement where applicable, and remaining limits. Mark a finding fixed only when its relevant path is verified. For presentation gaps, include browser evidence against the corresponding screenshot scenario. For source-format issues, exercise the actual catalog/runtime options and previously cached inputs as well as a freshly created fixture.  
Preserve user-owned work found at implementation start. During this audit a staged `.gitignore` change appeared concurrently; it was left untouched. The audit reports are separate untracked documentation files. Recheck current Git status before implementation, and never infer that the audit's initial clean state still applies. Do not edit memories or `THOUGHTS.md` unless the user separately requests it.

## Remaining uncertainty
The broad intermittent syntax-highlighting complaint is not fully diagnosed. Current plain TypeScript/Python fences tokenize correctly in direct probes, while raw HTML language annotations, updated diff rendering, theme behavior, and browser token colors need specific failing cases. Production browser timing and long-thread event-loop profiling remain necessary to quantify the source-confirmed costs. The reports identify mechanisms and executable regressions; they do not present inferred numbers as measured user experience.
