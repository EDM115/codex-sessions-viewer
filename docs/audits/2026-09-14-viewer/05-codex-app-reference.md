# Codex Desktop implementation reference
Date: 2026-09-14. Scope: read-only investigation of the user-provided copied Desktop package, followed by this implementation handoff. No application implementation changes were made. The report describes observed bundled code and separates adaptation proposals from proven behavior. Screenshot acceptance is documented separately by the coordinator.

## Source and evidence boundaries
Archive inspected: `OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0\app\resources\app.asar`. Its observed length was 324,915,597 bytes. The parsed ASAR header described 9,044 members. Its first four little-endian uint32 values were `[4,2489280,2489276,2489269]`; the file payload starts at `8 + 2489280`. Investigation read the header and selectively read relevant JavaScript members without extracting the archive or modifying the source copy.  
All `webview/assets/...` paths below are archive members, not separately extracted files. Offsets are approximate zero-based JavaScript string character offsets after UTF-8 decoding; they are not archive byte offsets or source-map line numbers. Bundled minified symbols are exact for this copy only and may change with the next build. Search by the member name and unique semantic strings as well as the symbol. The code establishes static behavior and call relationships, not live execution of every feature gate or proof that the supplied screenshots were produced by this exact build.  
The inspected code is React-based. Adapt its state boundaries, invariants, and interaction behavior to Vue and the existing viewer architecture; do not copy minified React components or import the Desktop bundle. No internet research or security audit was performed.

## Virtual scroll, measured heights, and reading position
The smallest useful reference is `webview/assets/thread-virtualizer-4f61d89b50be.js` (2,029 bytes). It implements a custom layout/range calculator, rather than wrapping a general-purpose virtualizer.

| Bundled symbol | Export | Observed role |
| --- | --- | --- |
| `t` | `t` | Constructs layout arrays and stable-key index from entries and measured heights. |
| `n` | `i` | Computes a visible range using distance from bottom, viewport height, overscan, and binary searches. |
| `r` | `a` | Restores a prior range length around a surviving anchor key. |
| `i` | `n` | Compensates distance from bottom using old and new anchor positions. |
| `a` | `r` | Calculates an estimated scroll position centering a turn. |

The layout uses `entry.turnKey`, with height equivalent to `Math.max(entry.minHeightPx ?? 0, measuredHeightsByKey[key] ?? entry.estimatedHeightPx ?? 280)`. It stores top offsets, bottom offsets, heights, per-entry gaps, total height, a key-to-index map, and explicit gap keys. `collapseEmptyRows` changes whether zero-height rows receive gaps. The range calculation clamps distances and viewport extent to the total layout and handles empty-row boundaries explicitly.  
The anchor correction is equivalent to:

```js
const oldAnchorEdge = previous.bottomOffsetsPx[oldIndex] + previous.heightsPx[oldIndex];
const newAnchorEdge = next.bottomOffsetsPx[newIndex] + next.heightsPx[newIndex];
return Math.max(0, distanceFromBottomPx + newAnchorEdge - oldAnchorEdge);
```

The consumer is `webview/assets/local-conversation-thread-44a1af03b9a3.js` (393,052 bytes), function `ey`, beginning around character 16,900. It imports the helpers as `sg` (layout), `rg` (range), `ig` (anchor correction), `ng` (range restoration), and `og` (turn positioning). Search anchors include `preserveMeasuredTurnViewport`, `measuredHeightsByKey`, `onLatestTurnHeightChange`, `retainedTurnKeys`, and `getPendingRestoreScrollDistanceFromBottomPx`.

| Location in consumer | Observed behavior | Why it matters |
| --- | --- | --- |
| Around 18,424 | Rebuilds layout from entries, gaps, and measured height state. | Estimation is a fallback, not the final geometry. |
| Around 22,846 | Height changes also compensate gap changes when empty rows appear or disappear. | Expanding a tool body can change both row height and surrounding layout. |
| Around 24,402 | A shared `ResizeObserver` batches turn measurements into a `Map`, distinguishing turns from latest-turn follow content. | Observation and scrolling are coordinated instead of each row independently changing scroll position. |
| Around 27,737 | Observes viewport height and subscribes to scroll-controller events. | Width/viewport changes must feed the same layout state. |
| Around 29,516 | Chooses an anchor, computes its correction, and calls `compensateScrollToDistanceFromBottomPx`. | Changes outside the viewport should not displace what the user is reading. |
| Around 32,913, `ny` | Measured elements have `data-turn-key`; mounted virtualized content forces `content-visibility:visible`. | Measurement must observe real rendered content. |
| Around 34,172, `oy` | Selects the first visible measured non-gap, nonempty turn surviving in the next layout. | An unmeasured estimate is a weaker reading-position anchor. |
| Following `oy`, `dy` | Persists measured heights plus `renderedWindow:{anchorKey,count}`. | Returning to a conversation can restore stable logical position. |

Observed constants are default gap `yy=12`, initial viewport fallback `by=800`, overscan count `xy=2`, and top-jump adjustment `Sy=10`. `uy(e,t)` treats a distance of at most 24 px as bottom-following when there is no response spacer; the spacer case uses a different boundary. These are reference defaults, not required viewer values.  
`webview/assets/thread-scroll-layout-3e622961d8b2.js` (18,330 bytes), function `Fe`, supplies the scroll controller. Its inputs include `preserveViewportOnContentGrowth`, `responseSpacer`, `initialOffset`, `scrollOrigin`, `onUserScrollToTop`, and `loadPastHiddenHistoryPages`. Around character 7,120 it captures `{distanceFromBottomPx,scrollHeightPx,wheelDistanceFromBottomPx}`, checks content growth on the next animation frame, and includes intervening wheel movement in compensation. The layout also observes container/content height to drive history loading.  
Adaptation proposal: retain the viewer's chosen virtualizer unless current source and discriminating checks prove it inadequate. Put stable identity, measured-height updates, explicit follow-bottom intent, anchor restoration, and asynchronous reveal behind one coherent conversation scrolling interface. Tool expansion, Markdown enhancement, image completion, width changes, and child-panel resizing must update the same geometry. Preserve explicit user movement during those updates. Do not treat a single `scrollToIndex` call against estimated heights as completed navigation.  
Acceptance implication: open a tool above or inside the viewport, resize the conversation, let streamed output grow, and jump to an old prompt. The intended prompt/reading position should remain stable; the active tail should follow only while follow-bottom is intended. Static source supports these requirements but does not verify the current viewer meets them.

## Prompt navigation rail and virtualized destinations
`webview/assets/thread-user-message-navigation-rail-app-2f4806629af6.js` (31,024 bytes) exports `AppThreadUserMessageNavigationRail` through local symbol `$t`. Both `$t` and `Nt` return null for fewer than four items. `Pt` contains the interaction and observer logic.

| Source anchor | Observed behavior |
| --- | --- |
| `data-content-search-unit-key`, around 21,780 | An `IntersectionObserver` tracks visible prompt identities, rooted at the conversation scroll element with a `-16px` top margin. |
| `data-turn-key`, `MutationObserver` | It preferentially observes the containing turn and discovers/removes targets as virtualized DOM changes. |
| Around 19,900, `qt=150` | Preview loading is delayed 150 ms, deduplicated by item identity, and made retryable after failure. |
| `onRevealItem`, around 20,650 | Navigation first queries the destination. If absent, it awaits reveal, queries again, and uses instant positioning after reveal. Existing DOM destinations can scroll smoothly. |
| `pointerCaptureTarget`, `elementFromPoint` | Pointer capture supports dragging/scrubbing through the rail. Instant drag navigation skips unloaded entries rather than repeatedly hydrating them. |
| `Bt`, around 29,000 | The destination user bubble or attachment receives a short highlight; reduced motion is respected. |

The relevant navigation sequence is logically `find item -> reveal/mount if missing -> find again -> scroll -> highlight`. It uses prompt identity, not only the virtual row index or a DOM query over currently mounted messages.  
Adaptation proposal: derive rail entries from the session's complete available prompt model and give each a stable navigation key. Provide a Vue reveal operation that expands collapsed enclosing content and waits for the target to mount and measure before final positioning. Track the active rail state from visible prompt/turn geometry. Add preview or drag behavior only where supported by the product acceptance requirements; the four-item threshold and 150 ms delay are observed Desktop choices, not universal requirements.  
Acceptance implication: clicking an early prompt must work when it is outside the current virtual window, including after expanding content and after returning from a child conversation. A rail that merely queries the current DOM cannot satisfy this behavior.

## Human-readable tool activity and disclosure
`webview/assets/active-tool-activity-label-d6ba12b4d8d7.js` (7,045 bytes) separates raw tool transport from the display label. `O` scans backward for relevant exec activity, first searching in-progress items, then completed ones. `A` interprets `parsedCmd.type`; `P` supplies execution-status labels; `j` produces search descriptions.

| Semantic input | Observed display treatment |
| --- | --- |
| `read` | Reading a target; skill definitions can show the skill name or Internal Knowledge. |
| `search` | Searching a folder, a query, or files generally. |
| `list_files` | Listing files or a named folder. |
| `format`, `lint`, `noop`, `test`, `unknown` | Running, ran, or stopped command with useful command detail. |
| Skill create/update detection | Creating/updating labels and edit-files icon. |

Semantic icon IDs include `run-command`, `internal-knowledge`, `code-searching`, `list-files`, `edit-files`, and `stop`. The query formatter `g` converts simple literal alternatives to a human-readable quoted list and declines regex structures it cannot safely summarize.  
`webview/assets/mcp-tool-item-content-42ecbd5c0c5d.js` (30,580 bytes), around character 9,992, invokes `Ie`, imported as export `a` from `app-initial-d9bed9d614d8.js`. The label receives completion status, tool and server names, arguments/result, source, app context, matching application, native application metadata, and platform. This proves labels may depend on semantic metadata and operation status; a universal underscore-to-space formatter does not reproduce the observed model. This investigation did not fully recover the implementation behind export `a`.  
Around 14,281 the MCP renderer resolves icons from semantic overrides, native application icons, app/plugin logos, browser/domain imagery, and generic fallbacks. The complete icon asset collection was not enumerated.  
Adaptation proposal: create a small normalized display model with stable call ID, raw name, family, friendly summary, status, icon kind, and expandable details. Implement explicit formatters for supported tool families with conservative fallback to the raw tool name. Keep readable command/search/file details separate from raw arguments. Unknown or ambiguous commands must remain accurately labeled rather than guessed.

## Mixed activity groups, per-call expansion, and raw detail
`webview/assets/agent-activity-units-4f119e22c2b1.js` (21,966 bytes) classifies source items through `ye` and assembles contiguous activity groups through `Z`. `Ge`, around character 18,850, groups compatible consecutive MCP calls. Eligibility requires groupable items, successful completion, no custom source, no automatic approval-review entries, no special result, and a server other than `computer-use`. Its group identity is equivalent to:

```js
JSON.stringify([
  item.invocation.server,
  item.invocation.tool,
  item.functionName,
  item.pluginId,
  item.appContext?.connectorId,
  item.appContext?.linkId,
  item.invocationResourceUri,
  label(item),
]);
```

The contiguous grouping rule means incompatible, failed, or specially presented calls stay distinct. The source does not support grouping every tool call in a turn solely because their raw names match.  
`webview/assets/tool-activity-disclosure-a88d9d3ac642.js` (2,429 bytes), component `S`, separates a running disclosure override from completed expansion state. Running activity shows its body until collapsed by the user; completed expansion is initialized from `defaultExpanded`. It animates measured height, sets `aria-hidden` and `inert` on collapsed content, and disables collapsed pointer events. `_` measures body height; `v` normalizes observer border-box/content-rectangle measurements.  
In `mcp-tool-item-content-42ecbd5c0c5d.js`, around character 13,550, raw output uses distinct dialog state and lazy serialization equivalent to:

```js
useMemo(
  () => open ? serialize({ callId, invocation, durationMs, result }, 2) : null,
  [open, callId, invocation, durationMs, result],
);
```

The associated message ID is `codex.mcpTool.rawOutputTriggerTooltip`, with text `Show raw tool call output`. This proves the raw diagnostic presentation is separate from the friendly summary and serialization can be deferred until requested.  
Adaptation proposal: model three distinct levels where the desired screenshots call for them: the turn's worked/activity summary, the ordered constituent activity/call rows, and an individual call's detail/raw presentation. Preserve call IDs and chronology when collapsing or regrouping. A failed call must remain discoverable even inside a mixed activity section. Expansion state should survive nearby streaming updates and regrouping when the underlying logical item survives.  
Acceptance implication: the user's collapsed Worked presentation, mixed summaries, and per-call expansion require independently addressable levels; one giant raw JSON disclosure or one undifferentiated tool list is insufficient. The source inspected here establishes activity grouping, call disclosure, and a raw dialog. It does not independently establish the precise outer Worked label, duration formatting, or every screenshot's group composition; those belong in screenshot acceptance and current viewer source review.

## Markdown enhancement and streamed code
The generic code renderer is `IUi` in `webview/assets/app-initial-d9bed9d614d8.js` (9,807,807 bytes), around character 5,773,900. Unique anchors are `deferEnhancementsUntilVisible`, `latestContent`, `latestLanguage`, `lastStartedAtMs`, `highlightCode`, and `s.startsWith(H.code)`.

- Enhancement can wait until an `IntersectionObserver` reports proximity using `rootMargin:"600px 0px"`.
- The highlighter is loaded dynamically from `webview/assets/highlight-code-73de9a6a203c.js`.
- Repeated highlighting is throttled while retaining the latest content/language.
- Highlighted output is reused only when current content starts with the input that produced it. Newly streamed suffix text renders immediately as plain text until the next highlight completes.
- Unknown-language errors leave the text fallback available.

`highlight-code-73de9a6a203c.js` (4,039 bytes) exports `highlightCode` (`Ge`), `detectCodeLanguage` (`Ke`), registered languages, and aliases. `Ge` selects explicit-language highlighting when given a language and `highlightAuto` otherwise.  
This is distinct from `webview/assets/shiki-highlight-provider-e18b5f9a8564.js` (1,782 bytes), exported `ShikiHighlightProvider` (`T`). That provider configures a worker factory using `worker-c95ad5902d1d.js`, pool size four, AST LRU size 100, theme selection, and line-diff rendering options. The presence of Shiki does not prove every conversation Markdown code block uses Shiki.  
`webview/assets/chatgpt-code-block-fa6a2071a092.js` provides another code-block path with dynamic language support. `Ht`, around character 7,822, deduplicates in-flight language imports, caches loaded support, and returns null for unknown languages/import failures. It should not be conflated with the generic conversation snippet path.  
Adaptation proposal: keep plain content immediately readable, then add highlighting without losing streamed suffixes. Cache work by content/language/theme as appropriate and defer expensive enhancement outside the viewport. Coordinate resulting geometry changes with the conversation's measurement controller. Do not introduce two highlight stacks merely because both appear in Desktop; first confirm the viewer's existing pipeline and choose the smallest compatible implementation.

## Favicon loading and offline adaptation
`app-initial-d9bed9d614d8.js`, functions `RBi` and `UBi`, around character 5,723,740, implement domain icons. `RBi` accepts only HTTP(S) URLs and builds `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.origin)}&sz=32`. `UBi` has a `loadRemote` switch; false prevents creation of that request URL. A local globe/mail fallback stays visible until image load succeeds. The image uses `decoding:"async"`, `referrerPolicy:"no-referrer"`, empty alt text, and a fixed icon container. `qBi` explicitly invokes the fallback with `loadRemote:false` when no known application icon exists.  
Adaptation proposal: carry over the fixed-size fallback and explicit remote-loading policy, not the Google request. This viewer's offline/loopback contract takes precedence. Use local semantic/file/app icons or already-available permitted imagery; a domain label plus local globe is an accurate offline fallback. Favicon failure must not leave broken-image chrome or change line geometry. This source inspection made no favicon requests.

## Subagent topology, status, and child conversations
`app-initial-d9bed9d614d8.js`, class `s1t`, around character 2,308,889, owns descendant discovery. It is assigned to `this.subagentTopology`; the manager exposes `getSubagentDescendantSnapshot` around character 2,427,168.

| Method or anchor | Observed behavior |
| --- | --- |
| `getSnapshot(ancestorId)` | Returns known descendants with `isComplete:false` and loading state. Cached knowledge is not declared exhaustive. |
| `discover` | Deduplicates per-ancestor requests and captures runtime state before discovery for reconciliation. |
| `discoverForSpawn` | Accepts both collaboration tool calls and subagent activity events. |
| `listDescendantThreads` | Pages `thread/list` with `sourceKinds:["subAgentThreadSpawn"]`; uses `ancestorThreadId` when supported and parent-based discovery otherwise. |

The Desktop network/server discovery mechanism is a reference for completeness semantics, not an instruction to add server calls to the offline viewer.  
`webview/assets/app-primary-17b54400f32a.js` (5,298,816 bytes), around characters 4,856,350–4,861,500, contains the membership and progress assembly. Useful exact functions are `Ydr`, `Xdr`, `Qdr`, `Zdr`, and `Jdr`.

- `Ydr` derives membership from `subAgentActivity` and `collabAgentToolCall` with `tool:"spawnAgent"`. The former provides agent path/thread identity; the latter uses receiver thread IDs.
- `Xdr` supplements membership from cached conversations, thread summaries, and source-linked threads, preserving explicit parent IDs and deduplicating known children.
- The parent resolution around character 4,857,579 considers `parentThreadId`, parsed source parent, thread metadata parent, and membership parent.
- `Qdr` links activity to the relevant parent turn and preserves objective, model, interaction capability, and agent state across wait/send/resume events.
- `Jdr` orders entries by recency. Presentation order is separate from the relationship used to establish membership.

`webview/assets/local-conversation-subagents-panel-tab-5d9af437ca4d.js` (7,861 bytes) supplies the visible local panel. `V` chooses list versus selected child conversation. `H`, around character 2,232, builds Active and Done sections, initially limiting the active section to four entries. `K` provides the selected child's header, back action, and available model/reasoning detail. The selected conversation reuses the conversation-thread component with its own conversation ID, host, interaction capability, and nested-agent opening callback.  
`webview/assets/subagent-panel-c26c21c05b21.js` (4,981 bytes) supplies reusable list/section/header components (`p`, `h`, `m`, `_`). `webview/assets/subagents-3d1bbd967a9e.js` describes its thumbnail count explicitly as loaded agents, potentially fewer than the total, and reads `getSubagentDescendantSnapshot(...).descendantThreads`.  
Observed limit: the inspected local panel is a grouped list with a child transcript detail view. It was not observed to render an indented hierarchy tree. Preserved topology and a visible hierarchy tree are different claims. Likewise, do not infer that every event contains enough metadata to discover a missing child file.  
Adaptation proposal: resolve topology from explicit session/source metadata and supported spawn/lifecycle records, keep parent relationships separate from visual ordering, and preserve unknown/missing states. Associate inline lifecycle entries with their parent turn while allowing the same child identity to open a conversation side panel. Reuse the transcript renderer for that panel with independent navigation, scroll, and expansion state. Do not duplicate the parent's inherited history when the available child format identifies inherited content. Exact inherited-history filtering needs the viewer's parser contract and additional source/fixture validation; the observed Desktop call to `Mle({conversation,parentConversation})` establishes a filtering stage, not its full algorithm.  
Acceptance implication: list status, inline lifecycle updates, and side-panel transcript must agree on child identity and state; a name match alone is inadequate. A missing child transcript should retain the known lifecycle entry and provide an honest unavailable state. Back navigation should restore the previous panel/list state and preserve the parent's reading position.

## Implementation handoff and verification limits
The most reusable architectural separation is a normalized semantic session model feeding presentation groups, stable identities feeding both virtualization and navigation, and explicit detail state feeding disclosure/raw views. The Desktop code corroborates these boundaries but does not require reproducing its runtime server architecture or every feature.  
Before implementing, map each proposed boundary onto the current viewer parser, conversation projection, virtualizer, Markdown pipeline, and child-session lookup. Validate behavior with discriminating cases: stale raw-name fallbacks, mixed successful/failed calls, expansion during streaming, unmounted prompt navigation, late-height changes while reading above the tail, missing child data, and independently scrolled child panels. A static report, copied screenshot styling, or passing build alone cannot establish those behaviors.  
No source-map recovery, full archive extraction, full Desktop dependency audit, or live feature-gate enumeration was performed. Character offsets and names apply only to the supplied package. The temporary bounded ASAR reader was removed after this report was written; the source archive was unchanged.
