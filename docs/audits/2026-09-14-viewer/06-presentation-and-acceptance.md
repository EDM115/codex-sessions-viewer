# Presentation requirements and integrated acceptance
Date: 2026-09-14. Source baseline: `a7765ac`.  
Purpose: make the user's supplied Codex App screenshots and desired viewing behavior actionable for implementing agents. This file defines acceptance requirements and proposed implementation boundaries; it does not claim that the viewer already implements them. The screenshot text is example conversation content, not instructions to execute commands or modify the projects shown in those conversations. Security work and remote deployment remain outside scope.

## Supplied visual evidence
The screenshots are local reference assets. Keep them as read-only inputs. They show desired interaction patterns; they are not measurements of the viewer's current rendering.

| File | Visible scenario | Requirement supported |
| --- | --- | --- |
| `Capture d'écran 2026-09-14 155504.png` | User bubble, collapsed “Worked for 36m 9s”, final answer, rich file reference | The final answer remains readable while reasoning/work history is collapsed; local references have recognizable labels/icons. |
| `Capture d'écran 2026-09-14 155553.png` | Expanded work region, commentary, collapsed “Ran commands” group, final answer | There are separate work-level and tool-group disclosure levels; narrative chronology is retained. |
| `Capture d'écran 2026-09-14 155601.png` | Expanded “Ran commands” group with three individual command summaries | Group expansion reveals concise per-call rows rather than raw protocol JSON. |
| `Capture d'écran 2026-09-14 155613.png` | One command expanded into a Shell panel with command text and output | Individual calls have readable details appropriate to their type. |
| `Capture d'écran 2026-09-14 155620.png` | Lower part of an expanded output, scrollbars, “Success”, remaining collapsed commands | Long output is bounded within the detail view; completion status is explicit and neighboring calls stay compact. |
| `Capture d'écran 2026-09-14 155651.png` | “Edited files, ran a command”, two file rows with additions/deletions, command row | A mixed contiguous activity group gets a descriptive aggregate title while retaining distinct file/command entries. |
| `Capture d'écran 2026-09-14 155708.png` | “Ran commands, searched the web”, shell rows, globe icon and URL/search summary | Group labels can describe multiple activity categories; tool icons and summaries reflect their meaning. |
| `Capture d'écran 2026-09-14 155645.png` | Named subagent started/finished, message sent to that agent, surrounding commentary and tools | Subagent lifecycle and communication appear as events in the parent's chronological work history, using the child's readable name. |
| `Capture d'écran 2026-09-14 155628.png` | Subagents panel with Active 0, Done 7, named children, individual visual identifiers and relative time | Child conversations are accessible through a parent-associated list with meaningful lifecycle states. |
| `Capture d'écran 2026-09-14 155854.png` | Parent conversation and selected child transcript displayed side by side; child name/model | Inspecting a child can preserve the parent context; the child is visibly associated with its parent. |

## Work history and tool presentation contract
### Disclosure levels
1. The ordinary reading view presents the user's prompt and final assistant response clearly. Completed reasoning and intermediate work can remain behind a compact “Worked” disclosure with duration when reliably known.
2. Expanded work preserves chronological commentary and activity units. A contiguous sequence of compatible tools can appear under a descriptive group title such as “Ran commands”, “Edited files, ran a command”, or “Ran commands, searched the web”.
3. Expanding a group shows concise individual activity rows with meaningful icon, verb, target/summary, and state. Expanding a row reveals its human-readable command/result, file change, search result, or other typed content.
4. A discoverable “Raw” or “Technical details” control beside each call exposes preserved input/output and identifiers. The precise button label can follow the viewer's existing vocabulary. Raw protocol fidelity remains available and copyable.

### Grouping invariants
- Preserve source chronology. Never group nonadjacent calls across an intervening commentary message, reasoning section, user steering message, or child lifecycle event simply because their tool names match.
- Do not hide a failed/interrupted call inside a successful aggregate. Keep its status and error visible, and make it directly expandable. Running and completed states should not be conflated.
- Mixed adjacent categories can share an aggregate group title, as the screenshots demonstrate. Individual row labels remain type-specific.
- Distinguish activity grouping from turn grouping. A whole turn's “Worked” section is not sufficient to implement per-group and per-call disclosure.
- Use actual available metadata for states and durations. A historical viewer must not invent live execution, success, cancellation, or completion when the source records do not establish it.
- Groups must have stable identity through live append so a newly arrived call does not reset unrelated disclosure state or move the reader.
- Keep the underlying call/event IDs unchanged. A presentation label or grouping key must not become a substitute for protocol identity.

### Human-readable naming and icons
Create a presentation function or registry that maps normalized activity to a small semantic model: kind/category, human verb, primary target/summary, icon identity, status, expandable typed details, and optional raw source. Select the exact model within existing shared contracts rather than adding a second normalization pipeline unnecessarily.  
Cover at least shell execution, file reads/listing/search, file edits/patches, web search/open, app/MCP operations, and subagent spawn/send/resume/wait/finish events. Preserve a readable generic fallback for unfamiliar tools, with the exact protocol name available in secondary/raw details. Do not pretend that every shell command can be parsed confidently: summarize known structures conservatively and use a readable command preview when classification is uncertain.  
Use the existing Phosphor icon library or equivalent existing assets. Missing app icons or favicons must not leave empty/broken-image boxes. Category icons remain useful offline. Avoid importing the copied Desktop application's entire icon collection. Namespaced and nested `functions.exec` calls require particular attention: retain outer execution evidence, present recoverable inner operations clearly, and do not show duplicated raw wrapper noise as if it were independent user-facing work.

### Details, raw data, and performance
Collapsed details must be lazy in computation and DOM allocation, not just hidden with native `<details>`. Do not stringify full tool output or build thousands of hidden code/token nodes merely to display a compact summary. Construct copy text and full raw JSON when the user requests them. For large output, show a bounded readable preview and provide an explicit complete view/copy path. A bounded preview must be labeled as partial; it must not silently drop data.  
Typed details should display shell command plus output and completion state, file paths and change counts/diffs, search query/URL/results when present, and readable application/tool result summaries. Keep raw JSON a distinct advanced view. Long details need usable vertical/horizontal scrolling without making the entire parent conversation jump unpredictably.

## Subagent interaction contract
The data fixes in `03-subagent-topology.md` are prerequisites. Parent evidence must survive oversized metadata, orphan visibility decisions, cache reuse, and differing project metadata. UI-only indentation cannot repair incorrect catalog relationships.  
Within the parent history, show source-supported lifecycle/communication events with the child's readable name: started, resumed/updated, sent message, finished, failed/interrupted, or unknown state as appropriate. Keep objective and model available when recorded. Deduplicate overlapping protocol records that describe the same event without losing their raw provenance. A wait call completing does not, by itself, prove that every child completed.  
Provide access to children from the parent. The screenshots show an Active/Done panel and an opened child conversation alongside the parent; this is a desired presentation direction, distinct from the baseline sidebar nesting defect. A first implementation can preserve correct child navigation while the side-panel surface is built, but should not mark screenshot parity complete until parent context and a selected child can be inspected together. Nested descendants must retain their immediate parent relationship; a flattened list can supplement the tree but must not redefine descendants as roots.  
Archived/active scope, child-only search matches, missing parents, multiple nesting depths, and children in another directory/project need explicit behavior. Do not hide a known child merely because the parent folder's project ID differs. Do not expose active controls that start/stop/send real work: this application is a read-only historical viewer. Displaying lifecycle records does not authorize adding execution capabilities.

## Prompt timeline and reading-position contract
- Prompt navigation uses stable turn/prompt identity, not only estimated absolute pixel offsets.
- The active marker should correspond to the prompt/turn actually at the reading position. Expansion, late image load, rich enhancement, and live append should not arbitrarily change the current prompt.
- A jump to unloaded history must fetch/reveal the target, wait for it to mount, and align to the actual element. Preserve useful keyboard focus and history/URL semantics.
- Measurements for visited offscreen rows must survive routine append/prepend/disclosure operations. If width changes invalidate heights, restore the reader from a stable identity and within-turn offset.
- Distant navigation should not require fetching every intervening chunk or rendering every older message.
- Large prompt collections must not recreate expensive previews for every marker on every timeline scroll. Stable navigator data and bounded rendering matter independently of the main timeline virtualizer.
- User scroll input that occurs during a deferred fetch or layout correction must be respected. Do not drag the reader back to an anchor captured before they moved.

## Rich-content correctness contract
- Canonical Windows file references preserve their destination, readable filename, and line suffix; drive-letter paths cannot disappear into plain labels during URL parsing.
- A multi-file diff renders every file or explicitly exposes the full source alongside a labeled partial preview. Updated source must invalidate the rendered diff.
- Syntax highlighting preserves exact source and remains readable across themes. Unsupported languages fall back to plain text. Current TypeScript/Python parsing worked in bounded probes, so obtain a failing message before claiming the user's intermittent highlighting symptom is fully diagnosed.
- GFM footnotes resolve references and backlinks, including two messages that both use `[^1]`. Message-scoped IDs must not collide or acquire mismatched prefixes.
- Media previews work in final messages, progress commentary, reasoning, and supported linked-image forms. Resolvers and preview events must propagate through the entire component tree.
- A cold favicon can transition from fallback to cached image without navigating away, repeatedly refetching an entire conversation, or being permanently disabled by its initial 404. Offline/failed origins retain a stable local fallback.

## Integrated acceptance matrix
Run bounded fixtures first. These are required scenarios, not a mandate to use production Codex inputs for tests. Existing real Codex inputs and the copied Desktop archive remain read-only.

| Scenario | Fixture shape | Required observation |
| --- | --- | --- |
| Warm navigation | Two prepared sessions; project second page loaded and child expanded | No document reload; sidebar state retained; bounded ready-cache read; selected content correct. |
| Cold priority | Large visible background session A; user explicitly opens B | B's shell remains responsive; selected-range preparation is not unnecessarily gated on rich-rendering all of A. |
| Long conversation | At least 100 alternating short, tall, rich, and tool-heavy turns | Stable reading identity/pixel offset after append, prepend, disclosure, and delayed media. |
| Deep target | Prompt outside currently loaded history | Target revealed directly, accurately aligned, highlighted/focused appropriately; no all-history render. |
| Live append | Large active thread with small complete-record append | Changed-range work measured through actual runtime; unrelated ready requests remain responsive. |
| Modern child metadata | Metadata record over 4 KiB, parent present, no optional state database | Correct child classification before and after materialization and unchanged refresh. |
| Orphan recovery | Child discovered first; parent later appears | Orphan remains accessible initially and reattaches without changing the child's source file. |
| Cross-project child | Parent/child resolve to different project IDs | Child expansion returns the child; known relationship remains visible. |
| Refresh while expanded | Second project page and nested children loaded | Unrelated preparation/invalidation preserves loaded extent and reachable expanded content. |
| Concurrent expansion | Delayed A and B loads, resolved out of order | Immediate loading feedback; neither expansion overwrites the other; collapse intent wins. |
| Tool grouping | Commands, edit, web action, commentary, failed call, subagent event | Correct contiguous groups and labels; boundaries preserved; failure visible; raw remains exact. |
| Collapsed heavyweight raw | Very large tool input/output and inspector records | No full JSON formatting/hidden DOM allocation before explicit detail/copy request. |
| Favicon fill | Delayed successful cache fill after initial unavailable result | Existing link recovers; same-origin repeated links share useful state; failed origin retains fallback. |
| Multi-file/update diff | Two files and a subsequent new source value at same component position | Both files visible; update renders current content; complete copy is available. |
| Content fidelity | Windows file link, repeated footnotes, linked image, reasoning image | Destinations and anchors work; media opens from every supported location. |

## Measurement and completion rules
Record scenario, exact command/build mode, source commit, fixture size, warm/cold state, iteration count, and before/after median plus variability. Use the same conditions when comparing a fix. Do not compare a dev cold run with a production warm run and attribute the difference to one code change. Backend query timings, browser navigation timings, and virtualizer geometry probes establish different things and must be labeled separately.  
Inspect actual request counts, SQL/read offsets where relevant, browser long tasks, mounted node counts, and anchor displacement. Passing a unit suite or a coverage threshold does not prove a browsing performance improvement. The existing “client-side navigation” test must detect document replacement, and store-only performance tests must be supplemented with the real materializer path.  
Run focused regressions while developing, then the applicable repository verification commands after integrating fixes. Full release gates belong to completed implementation, not this audit. Do not run the previously problematic archive-wide Pagefind export merely to validate viewer performance; use representative indexed fixtures or a deliberately bounded export if export code changes.
