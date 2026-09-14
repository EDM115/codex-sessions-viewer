# Timeline and rendering audit
Audit date: 2026-09-14. Initial checkout: `a7765ac`.  
Scope: conversation virtualization, dynamic heights, scroll anchoring, right-hand turn navigation, initial rendering, and work performed by collapsed turns. This report author performed read-only source inspection and inline Node probes, then created this report under the user's explicit documentation authorization. No implementation changes, Git mutations, or edits to `THOUGHTS.md` were made. No full browser profiling was performed. Screenshot-specific visual requirements are documented in `06-presentation-and-acceptance.md`; this report establishes the current geometry mechanisms independently of those examples.  
All application source references below are relative to the repository root and describe the inspected checkout. Verify locations after concurrent implementation changes. Dependency references describe the installed `@tanstack/virtual-core@3.17.8` and `@tanstack/vue-virtual@3.13.36`; re-check their API if dependencies change.
## Findings and confidence
| ID | Priority | Finding | Evidence level |
| --- | --- | --- | --- |
| TL-01 | P1 | Routine global measurement resets discard offscreen heights and can unmount the reading anchor before restoration | Source call chain plus executed installed-dependency probes |
| TL-02 | P1 | The intended custom scroll adjustment callback is passed through an unsupported options field and never executes | Source call chain plus executed installed-dependency probe |
| TL-03 | P2 | Rendering a collapsed turn eagerly serializes its complete tool history for an unused copy action | Direct source proof; real-user timing unprofiled |
| TL-04 | P2 | The minimap renders the full history and receives a new array on parent updates, creating work proportional to total turn count during scrolling | Direct source proof; browser frame-time impact unprofiled |
The fixed 520px estimate alone is not sufficient evidence of a defect: variable-height virtualization necessarily estimates unvisited content. The actionable defects are discarding learned measurements, ignoring the intended correction policy, and doing avoidable work outside the bounded virtual row set. Tune estimation only after those mechanisms are corrected and actual browser measurements exist.
## Current behavior and geometry model
`app/components/conversation/ConversationView.vue:50` defines one estimate, `ESTIMATED_TURN_SIZE = 520`. Lines 94-107 configure a virtualizer over currently loaded `timeline.turns`, with turn IDs as item keys and an overscan of three rows. Lines 143-146 attach dynamic measurement to rendered row elements. Lines 534-560 give the virtual container the computed total height and absolutely position each mounted row at its measured or estimated start.  
The main scroller's current turn is determined at `ConversationView.vue:194-204`: the reading line is `scrollTop + clientHeight * 0.3`, and `shared/timeline/turnMinimap.ts:11-22` chooses the virtual row containing that line. This is conceptually more appropriate than choosing the nearest row start for tall turns. Its correctness still depends on the row coordinates being current and on updates reaching the selected marker at the appropriate time.  
The right-hand minimap is an ordered, independently scrollable list of turn markers, not a scaled projection of the conversation's measured vertical lengths. `TurnMinimap.vue:116-153` renders one marker per navigator item. `app/assets/css/components.css:2676-2697` places the markers in a grid with minimum target height `0.8rem`; coarse pointers use `2.75rem` at lines 2893-2896. `shared/timeline/turnMinimap.ts:3` and lines 25-26 map four prose-length buckets to marker widths 18, 30, 44, and 60 pixels. Those bucket widths are not row-height estimates.  
Consequently, a wrong current marker or broken target jump can originate in conversation geometry even when the minimap's own marker positions are internally consistent. Keep these two coordinate systems distinct during implementation. If a screenshot requires a proportional overview instead of the present ordered navigation list, treat that as a separate product requirement with explicit navigation and accessibility behavior; changing the estimator does not implement that design.
## TL-01: Global measurement resets can remove the reading anchor
### Trigger and user impact
A user scrolls through a substantial history, allowing variable-height turns to be measured, then loads later turns, loads earlier turns, opens/closes worked details, or receives a live refresh. Those paths can clear all learned heights. Offscreen rows return to 520px, the cumulative height before the current position changes, and the virtualizer may mount a different portion of the history. The right-hand current-turn calculation then describes the displaced viewport rather than the user's original reading location.  
This can produce large jumps rather than a minor estimate correction. A DOM-only restoration routine cannot restore a turn that the same reset just removed from the DOM.
### Source evidence
| Source | Relevant behavior |
| --- | --- |
| `app/components/conversation/ConversationView.vue:188-192` | `loadAfter()` calls `virtualizer.value.measure()` after a later chunk and a Vue tick |
| `app/components/conversation/ConversationView.vue:110` | Passes `() => virtualizer.value.measure()` into `useScrollAnchoring` |
| `app/composables/useScrollAnchoring.ts:68-70` | Every successful anchor restoration calls the supplied global measurement function before settlement |
| `app/components/conversation/ConversationView.vue:153-176` | Prepend path captures an anchor, adds `newTurnCount * 520` to scrollTop, then restores |
| `app/components/conversation/ConversationView.vue:229-236` | Disclosure resize path restores through the same anchoring helper |
| `app/components/conversation/ConversationView.vue:360-374` | Live refresh captures and restores through the same helper |
| `app/components/conversation/ConversationView.vue:375-386` | Live follow has another direct global measurement call after loading later turns |
| `app/composables/useScrollAnchoring.ts:47-56` | Restoration searches only mounted `[data-turn-id]` elements and returns false if the anchor is missing |
| `app/composables/useScrollAnchoring.ts:59-65` | Repeats the DOM-only attempt over three further animation frames without an index-based recovery |
| `node_modules/.pnpm/@tanstack+virtual-core@3.17.8/node_modules/@tanstack/virtual-core/src/index.ts:1976-1984` | `measure()` clears `itemSizeCache` and notifies a rebuild; it does not just remeasure visible elements |
### Executed evidence
An inline program using the installed dependency measured 50 rows as 1000px each. Before reset, 50 cache entries described total height 50,000px and row 30 started at 30,000px. After `measure()`, there were zero cached sizes, total height was 26,000px, and row 30 started at 15,600px.  
A separate 100-row probe at fixed offset 30,000px changed the mounted indexes from `[27,28,29,30,31,32,33]` to `[54,55,56,57,58,59,60,61,62]` solely by clearing measurements. This establishes that the anchor can leave the virtual range before the DOM-only restore executes. It does not claim a measured pixel jump from a live browser session.
### Remedy and invariants
Preserve learned item sizes during append, prepend, and ordinary content changes. Dynamic measurements are already attached to mounted elements; use that mechanism to update changed rows. Reserve whole-list invalidation for a genuine layout invalidation, such as a width change that makes old wrapping measurements unusable. Coordinate that invalidation with anchor recovery rather than triggering it as a generic refresh operation.  
Represent the reading position by stable turn ID and a pixel offset within that turn. Keep an index-based way to bring the anchor back into the virtual range if it is temporarily unmounted. Avoid two competing correction systems adding independent offsets for the same prepend or measurement. Retain the existing request-generation protections while replacing the geometry mechanism.  
Do not declare success merely because a constant-height fixture remains stable. Previously visited rows should preserve their sizes unless their rendering inputs actually change; appending unrelated turns should not change their geometry. A deliberate layout invalidation must recover the same reading content at the new width even when absolute heights change.
### Ownership and dependencies
Primary implementation ownership: `ConversationView.vue` and `useScrollAnchoring.ts`. Supporting policy: `shared/timeline/scrollAnchoring.ts`. Regression ownership: timeline integration and browser tests.  
Coordinate with TL-02 because the correction callback changes whether the virtualizer moves scrollTop after measurements. Coordinate with any width-responsive redesign and disclosure-state changes. Do not change the repository pagination protocol just to fix geometry.
### Regression acceptance
1. Create a deterministic browser fixture with at least 100 turns alternating compact prose, tall prose, multiline code, and activity-heavy turns. Use actual rendered content, not only mocked heights.
2. Traverse several chunks to populate measurements, return to a deep middle turn, and record its stable ID and its visual offset from the scroller top.
3. Append an unrelated chunk. Assert the same anchor and offset within a small explicit tolerance after settlement, with no transient jump to a distant turn.
4. Prepend a deferred chunk after moving the reading position while the response is outstanding. Preserve the position captured immediately before application, retaining the behavior covered by the existing deferred-prepend test.
5. Repeat after opening and closing worked details above the viewport, at the viewport boundary, and inside a tall visible turn.
6. Repeat during live refresh while live-follow is disabled and while it is enabled but the user is away from the end.
7. Resize the viewport and introduce delayed image/diagram height changes after more than three animation frames. Assert recovered content, not merely successful completion of a timer.
8. Ensure the restored anchor's identity does not silently change when the virtual range temporarily excludes it.
## TL-02: The scroll correction callback is never connected
### Trigger and user impact
The viewer intends to correct size changes only when a row is entirely above the current viewport. The supplied callback is not invoked, so the installed library's default correction policy runs. In particular, a first measurement of a row whose top is above the fold can shift scrollTop even if that row spans the reading area. TL-01 increases exposure by converting previously measured rows back into first measurements.
### Source evidence and root cause
`app/components/conversation/ConversationView.vue:101-105` includes `shouldAdjustScrollPositionOnItemSizeChange` inside the object passed to `useVirtualizer`. Its body calls `shouldAdjustForMeasuredRow`, whose policy is `row.end < scrollOffset` at `shared/timeline/scrollAnchoring.ts:12-17`.  
In the installed core, the callback is an instance property declared at `src/index.ts:450-456` and read from `this.shouldAdjustScrollPositionOnItemSizeChange` at lines 1605-1624. The installed Vue adapter, `node_modules/.pnpm/@tanstack+vue-virtual@3.13.36_vue@3.5.41_typescript@6.0.3_/node_modules/@tanstack/vue-virtual/src/index.ts`, constructs a `Virtualizer` and forwards changing options through `setOptions`; it does not copy this field onto the instance. A structurally accepted extra property in the computed options object therefore does not establish the intended integration.
### Executed evidence
The probe below provides a callback that always returns false. The callback appears on `v.options`, but the corresponding instance property is undefined and the callback invocation count remains zero. Resizing row 1 from estimated 520px to 1000px at offset 600px produces an adjustment of +480px. This is an executed dependency behavior, not merely a type-signature inference.
### Remedy and invariants
Install the policy using the supported instance API of the pinned dependency. Assert that the actual instance callback executes in a focused integration test. Keep the intended visible-row behavior explicit: changes below the current reading anchor should not drag that anchor down; changed content wholly above it should compensate appropriately. Review the exact-equality boundary (`row.end === scrollOffset`) and backward-scrolling behavior as part of that policy rather than accidentally inheriting a mixture of defaults and custom rules.  
Do not modify a dependency locally or upgrade it merely to make an unsupported options field appear to work. If an upgrade is separately selected, rerun the integration probe and browser acceptance against the new installed API.
### Ownership and acceptance
Primary ownership: `ConversationView.vue` and `shared/timeline/scrollAnchoring.ts`; tests must instantiate the real virtualizer. TL-01 and TL-02 should be reviewed together but remain separately testable.  
Acceptance requires proving the callback is called; a size change in a row spanning the viewport does not apply an unwanted whole-row delta; a changed row entirely above the viewport applies the required correction; and first measurement, subsequent resize, forward scroll, backward scroll, and a programmatic target jump remain stable. A unit test of the predicate alone does not satisfy this acceptance.
## Reproducible installed-dependency probes
Run from the repository root with PowerShell 7. This uses the project-provided Node executable, writes no source files, reads no Codex archive data, and performs no network access. The hardcoded dependency directory is intentionally the version actually audited; adjust it only after checking the installed package version.
```powershell
@'
import { Virtualizer } from './node_modules/.pnpm/@tanstack+virtual-core@3.17.8/node_modules/@tanstack/virtual-core/dist/esm/index.js';
let callbackCalls = 0;
const scrolls = [];
const v = new Virtualizer({
  count: 50,
  getScrollElement: () => null,
  estimateSize: () => 520,
  initialRect: { width: 900, height: 800 },
  initialOffset: 600,
  observeElementRect: () => () => {},
  observeElementOffset: () => () => {},
  scrollToFn: (offset, options) => scrolls.push({ offset, ...options }),
  shouldAdjustScrollPositionOnItemSizeChange: () => { callbackCalls++; return false; },
});
v.getTotalSize();
v.resizeItem(1, 1000);
console.log(JSON.stringify({
  callbackOnOptions: typeof v.options.shouldAdjustScrollPositionOnItemSizeChange,
  callbackOnInstance: typeof v.shouldAdjustScrollPositionOnItemSizeChange,
  callbackCalls,
  scrolls,
}));
for (let index = 0; index < 50; index++) {
  v.getTotalSize();
  v.resizeItem(index, 1000);
}
const before = { measured: v.itemSizeCache.size, total: v.getTotalSize(), row30Start: v.measurementsCache[30].start };
v.measure();
console.log(JSON.stringify({ before, after: { measured: v.itemSizeCache.size, total: v.getTotalSize(), row30Start: v.measurementsCache[30].start } }));
const range = new Virtualizer({
  count: 100,
  getScrollElement: () => null,
  estimateSize: () => 520,
  initialRect: { width: 900, height: 800 },
  initialOffset: 30000,
  overscan: 3,
  observeElementRect: () => () => {},
  observeElementOffset: () => () => {},
  scrollToFn: () => {},
});
range.shouldAdjustScrollPositionOnItemSizeChange = () => false;
range.getTotalSize();
for (let index = 0; index < 100; index++) {
  range.getTotalSize();
  range.resizeItem(index, 1000);
}
console.log(JSON.stringify({ phase: 'measured', rows: range.getVirtualItems().map(row => row.index) }));
range.measure();
console.log(JSON.stringify({ phase: 'afterMeasure', rows: range.getVirtualItems().map(row => row.index) }));
'@ | & ./node_modules/node/bin/node.exe --input-type=module
```
Observed outputs from the component probes executed during this audit:
```json
{"callbackOnOptions":"function","callbackOnInstance":"undefined","callbackCalls":0,"scrolls":[{"offset":600,"adjustments":480}]}
{"before":{"measured":50,"total":50000,"row30Start":30000},"after":{"measured":0,"total":26000,"row30Start":15600}}
{"phase":"measured","rows":[27,28,29,30,31,32,33]}
{"phase":"afterMeasure","rows":[54,55,56,57,58,59,60,61,62]}
```
These isolated probes demonstrate the relevant dependency semantics. They deliberately omit real DOM measurement and Vue scheduling, so browser regressions must still verify the application-level outcome.
## TL-03: Copy serialization is performed during ordinary rendering
### Trigger, evidence, and impact
`app/components/conversation/ConversationTurn.vue:29` declares `computed(() => agentWorkText(props.turn))`. Computed values are lazy in isolation, but the binding `:agent-work="workText"` at line 63 forces evaluation whenever the final assistant message is rendered. The resulting text is used by the user-triggered `copyAgentWork()` at `ConversationMessage.vue:38-40`; the full string is not required to display the ordinary conversation.  
`app/components/conversation/format.ts:143-175` builds message/activity maps, walks the turn's complete entry order, formats activity content, and joins the result. Tool activities format both full input and output at lines 95-96, using `JSON.stringify(value, null, 2)` for structured values at lines 80-81. Large tool histories therefore incur serialization and additional string allocation even when the worked disclosure is closed.  
This cost repeats when a virtualized turn unmounts and remounts. Initial rendering performs additional work because `ConversationView.vue:562-574` renders all initial turns in the SSR/fallback branch, `app/pages/session/[id].vue:34-37` requests 20 initial turns, and `ConversationView.vue:446-450` switches to separately mounted virtual rows after mounting. The exact browser-time contribution has not been measured and should not be presented as the sole cause of slow history loading.
### Remedy and preserved behavior
Make agent-work text production a user-action operation: emit a copy request to the turn owner or pass a lazy producer instead of an already serialized string. Preserve the existing message/activity ordering, final-message exclusion, steering-message treatment, tool formatting, error state, and successful clipboard feedback. Avoid caching a second giant copy string for every loaded turn unless measured repeated-copy behavior justifies it.  
If copy generation remains materially expensive after becoming on-demand, isolate and measure that action before adding asynchronous scheduling or worker infrastructure. Do not add a worker, a generalized cache, or a protocol change as a prerequisite for avoiding eager work.  
Treat initial SSR/hydration work as an amplification to profile separately. Do not remove accessible/server-rendered conversation content without an explicit rendering contract. Compare first usable content, hydration duration, mounted node count, and repeated content setup for representative heavy initial chunks.
### Ownership and dependencies
Primary ownership: `ConversationTurn.vue`, `ConversationMessage.vue`, and `format.ts`. Focused tests belong with existing conversation component/format tests. This can be implemented independently of TL-01/TL-02, provided the copy behavior is retained. Coordinate component event/prop interfaces before concurrent edits to `ConversationView.vue` or the work-stream components.
### Regression acceptance
1. Mount a turn with a final response, many tool activities, and large structured input/output while the worked disclosure remains closed.
2. Instrument the actual serialization function or lazy producer. Ordinary mounting, minimap selection changes, scroll-driven remounting, and opening the copy-options menu must not generate full agent-work text.
3. Clicking the agent-work copy action invokes generation exactly for the requested turn and writes the expected complete text to a mocked clipboard.
4. Preserve exact chronological ordering and exclusions using a fixture containing a user prompt, steering input, intermediate assistant messages, tools, and a final assistant response.
5. Verify clipboard failure feedback and retry after failure; invoking the action must not corrupt disclosure or scroll state.
6. Record a representative browser trace before and after. Report elapsed timings and allocations as measured observations, with fixture size and browser conditions, rather than inventing a performance threshold after seeing the result.
## TL-04: Minimap rendering is proportional to whole-history size
### Trigger and evidence
The parent passes `:items="[...navigatorItems]"` at `app/components/conversation/ConversationView.vue:597`, allocating a fresh array whenever that render expression runs. The virtualizer's reactive updates drive parent rendering during scrolling, so stable navigator data can still arrive at the child with a new identity.  
`app/components/conversation/TurnMinimap.vue:116-153` loops over all items, producing a button, marker, reactive state attributes, handlers, and refs for every turn. `TurnMinimap.vue:134` calls `minimapPreview(item)` while generating each accessible label; `shared/timeline/turnMinimap.ts:33-37` normalizes both prompt and assistant text even though only the prompt is needed there. The shallow items watcher at `TurnMinimap.vue:90-94` schedules another post-render preview geometry update for each new array.  
Thus virtualization of the conversation's rows does not bound the sidebar's DOM or its rendering work. The static work scales with total navigator count. This audit did not capture browser frame timings or establish the turn count at which it becomes perceptible on the user's hardware.
### Remedy and invariants
First preserve navigator array identity and accept readonly items in the minimap's prop contract. Precompute stable label/preview information when navigator data actually changes, avoiding repeated normalization during geometry-only updates. Verify those smaller changes before introducing a more complex rendering strategy.  
For histories large enough to exceed the agreed browser budget, window the independently scrollable marker list using its actual target dimensions. Maintain an explicit mapping between logical turn index and mounted marker index. Programmatic current-marker reveal and keyboard navigation must be able to bring an offscreen marker into the mounted window before focusing or measuring it.  
Retain exact turn-ID selection, `aria-current`, pending/error state, arrow/Home/End navigation, narrow-screen toggle focus restoration, coarse-pointer target size, and tooltip positioning relative to the visible marker. Do not assume the 0.8rem desktop target height when the coarse-pointer rule uses 2.75rem. The marker widths remain prose-length buckets unless the coordinator explicitly selects another overview design.
### Ownership and dependencies
Primary ownership: `ConversationView.vue`, `TurnMinimap.vue`, `shared/timeline/turnMinimap.ts`, and minimap CSS. Tests belong in conversation UI, timeline helper, and browser suites. Coordinate `ConversationView.vue` edits with the geometry owner. Keep navigation behavior separate from row-height estimation; the sidebar's marker order is not a substitute for the virtualizer's measured row positions.
### Regression acceptance
1. Use a navigator fixture large enough to expose full-list work, such as 5,000 turns, without loading 5,000 heavyweight conversation bodies.
2. Scroll the main history while the navigator content and current turn remain unchanged. Assert stable items identity and no repeated per-item preview preprocessing.
3. If marker windowing is introduced, assert that mounted marker count stays proportional to viewport size plus overscan rather than total turn count.
4. Navigate by arrows, Home, and End across unmounted boundaries. Assert the exact selected turn ID, loaded target, current marker, and focused element.
5. Test narrow layout open/select/close behavior and focus restoration to the toggle, including a selected marker near the end of the full navigator.
6. Validate tooltip centers after sidebar scrolling and resizing, with both ordinary and coarse-pointer target dimensions.
7. Capture frame-time and DOM-count evidence before and after using the same fixture and viewport. Report unmeasured conditions explicitly.
## Existing verification and missing coverage
| Existing coverage | What it proves | What it does not prove |
| --- | --- | --- |
| `tests/unit/timeline/useScrollAnchoring.test.ts:15-19` | The standalone `shouldAdjustForMeasuredRow` predicate has the expected truth table | That the actual virtualizer invokes it |
| `tests/unit/ui/conversationTimeline.test.ts` | Chunk sequencing, stale-response protection, targeted loading, and capture/application callbacks | Dynamic browser geometry, virtual row measurement, or anchor remount recovery |
| `tests/e2e/foundation.spec.ts:77-111` | Exact-turn opening, fewer than 20 mounted timeline turns, worked disclosure, inspector, and focus restoration for a small fixture | Bounded work inside a single heavy turn or the full minimap |
| `tests/e2e/foundation.spec.ts:113-151` | Deferred prepend preserves a moved reading anchor near turn 21 in the existing fixture | Deep measured-history invalidation with large cumulative estimate error |
| `tests/e2e/foundation.spec.ts:153-241` | Narrow minimap target jumps/focus and a single tall turn remaining active after a 300px scroll | Late size changes, resize recovery, repeated append/reset behavior, or many tall offscreen rows |
| `tests/unit/ui/conversation.test.ts:360` and `:384` | Minimap keyboard events and preview centering behavior | Scaling and focus across a virtualized marker window |
| `tests/performance/normalizationScale.test.ts`, `repositoryScale.test.ts`, `liveCatalogStartup.test.ts`, `deepSearchScale.test.ts` | Server/data-path scalability within those tests' fixture and assertion scope | Browser rendering/hydration cost or minimap frame-time behavior |
The audit inspected these coverage boundaries; it did not run the complete source/release suites. Existing test success from a previous run must not be cited as browser acceptance of the remedies in this report. Add discriminating regressions around the observed mechanisms rather than snapshotting source or testing only the desired helper implementation.
## Suggested implementation order and completion evidence
1. Add a focused installed-virtualizer integration regression for TL-02, then attach the policy through the supported API.
2. Add a deep-history browser regression for TL-01, then remove routine full measurement invalidation and make anchor recovery resilient to virtualization.
3. Move full agent-work serialization to the copy action and prove that ordinary rendering does not invoke it.
4. Stabilize minimap data/derived labels, measure large-navigator behavior, and introduce marker windowing if required by the agreed interaction budget.
5. Exercise delayed rich-content resize, viewport resize, target jumps, live refresh/follow, and narrow/coarse-pointer navigation together after independent fixes pass.
Completion evidence should identify the final tested revision, exact commands, fixture sizes, relevant screenshots or browser traces, and remaining limitations. Separate dependency-level assertions, component tests, browser geometry acceptance, and measured performance. A passing typecheck or helper unit test alone cannot close TL-01 or TL-02; a screenshot alone cannot establish loading or scrolling performance.  
The coordinator owns cross-cutting screenshot requirements, overall report indexing, and broader data-fetching performance investigations. This report does not claim that all history latency originates in the renderer, and its proposed fixes should not modify Codex source data or expand the application's local-only behavior.
