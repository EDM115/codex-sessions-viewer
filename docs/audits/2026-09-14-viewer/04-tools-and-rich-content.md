# Tools, inspector, and rich-content audit
Audit date: 2026-09-14. Source revision: `a7765ac`.  
This document specifies fixes for agents implementing the reviewed findings. The audit changed no application implementation, tests, source data, or Git state. Findings below distinguish reproduced parser failures, failures established by the current component/callback chain, and requested presentation improvements. Browser acceptance of the proposed fixes remains outstanding. No remote favicon was fetched during this audit. The coordinator's screenshot reference document owns the complete visual specification; the tool requirements captured here are the command summary, mixed-tool group title, individual command expansion, and readable result state such as “Success”.

## Scope and implementation boundaries
Preserve authoritative Codex input files, raw protocol records, chronological evidence, raw tool identity, pairing, and source Markdown. Implement presentation improvements as derived view models wherever possible. Do not simplify the normalized evidence merely to make a card attractive.  
Use the supplied checkout. Do not stage, commit, branch, create worktrees, reset, or mutate Git state. Do not edit `THOUGHTS.md`. Work stays local; favicon cache population must retain the existing explicitly bounded enrichment behavior. A browser rendering change must not introduce direct remote image/favicon loading. No security audit was performed here.  
Keep unknown tools readable and inspectable. Distinguish real failures from unknown or incomplete status. Preserve exact commands and outputs for copy/raw inspection even when a concise human summary is displayed. Avoid new dependencies until the installed Vue, Phosphor, Shiki, and diff tooling has been evaluated.

## Priority and evidence map

| ID | Priority | Finding | Evidence level |
| --- | --- | --- | --- |
| RC-01 | P1 | A first favicon failure stays sticky after live cache completion | Confirmed callback and component-state defect; no remote request executed |
| RC-02 | P1 | Multi-file fenced diffs hide every file after the first | Confirmed source data omission |
| RC-03 | P2 | Updated diff source retains an old mounted preview | Confirmed missing reactive update path |
| RC-04 | P2 | Progress/reasoning media buttons cannot reach the shared viewer | Confirmed event-forwarding break |
| RC-05 | P2 | Windows absolute Markdown file links lose their destinations | Reproduced with installed Node/jiti |
| RC-06 | P2 | Footnote references and backlinks do not resolve | Reproduced with installed Node/jiti |
| RC-07 | P2 | Images nested inside links do not receive asset resolution | Parser shape reproduced; component wiring defect confirmed |
| RC-08 | P2 | Tool cards lack requested semantic names, icons, summaries, and grouping | Confirmed presentation gap; screenshot-driven implementation requested |
| RC-09 | P2 | Closed technical/raw disclosures still allocate complete payload text and DOM | Confirmed eager component rendering; no timing claim |
| RC-10 | P2 | Inspector related records are opaque IDs with few raw navigation controls | Confirmed presentation gap |
| RC-11 | P2 | Attachment IDs and media activities lack an effective preview path | Confirmed current rendering gap; coordinate normalization ownership |
| RC-12 | Investigation | User-reported general syntax-highlighting failure | Not reproduced for ordinary TypeScript/Python fences |

P1 here means visible content is missing or a main requested feature remains broken through its ordinary cold-state lifecycle; these are audit priorities, not claims of a security boundary failure.

## RC-01: Recover favicons when background enrichment completes
### Current path and root cause
`app/repositories/live.ts:182` returns `/api/favicons/<base64url-origin>` immediately; the server-side live repository does likewise at `server/live/repository.ts:159`. `server/api/favicons/[originKey].get.ts:12` resolves a known origin and serves only its cached file. A first request can therefore fail while that cache entry is unavailable.  
`server/content/favicons.ts:617` deliberately returns a fallback and starts a background refresh in live mode. `server/live/reconciler.ts:343` prepares rich content, and its background completion callback at line 359 publishes `session.updated`. `app/components/conversation/ConversationView.vue:459` receives that invalidation and refreshes the conversation.  
`app/components/content/RichLink.vue:66` resolves its favicon only in `onMounted`. Its image error handler at line 109 sets `faviconFailed = true`, and no code resets it. The conditional at line 104 then removes the image in favor of a globe. Conversation refreshes preserve stable message/component identity, and rich children use index keys, so replacing props does not guarantee a remount. The downloaded icon can exist in the viewer cache while that link remains a globe. Changing the link origin at the same AST position also retains stale mounted state.
### Fix contract
Make icon state respond to both the current origin and the availability of a newly cached favicon. An origin watcher alone is insufficient: the cold-cache case changes availability without changing the origin or URL. A stable reactive cache signal, a narrowly scoped icon invalidation, or a resolver contract carrying availability/revision can satisfy this requirement.  
Reset failure and URL state when their identity changes. Guard asynchronous resolver results so an old origin cannot overwrite a newer link. Retry a formerly missing cached icon when its availability changes, with an explicit bounded policy; do not continuously retry genuinely unavailable icons. Preserve a local fallback while unavailable.  
Consider replacing favicon-triggered full-conversation refreshes with a lighter availability update. The current callback can cause one transcript refresh per completed origin. This is a source-backed opportunity to reduce unnecessary work, not a measured timing claim. Avoid using broad remounts of the entire conversation as the fix, because they discard disclosure/scroll/media state and repeat unrelated rendering.
### Required verification

- Mount a link with a cache URL, dispatch its first image error, then simulate successful cache completion. Assert that the same mounted link displays the cached image without navigating away or reopening the conversation.
- Change origin A to origin B at the same AST position. Resolve A after B and confirm B retains the right icon.
- Verify a genuine unavailable icon remains a stable local fallback without an unbounded retry loop.
- Exercise the real live invalidation-to-link path with a controlled local fixture and a fake enrichment completion; no real internet request is needed.
- Keep the existing immediately cached icon test, but do not treat it as coverage of the cold-cache lifecycle.

The current isolated successful-resolver test is `tests/unit/content-rendering/richTextRenderer.test.ts`. Server enrichment tests are under `tests/unit/content/favicons.test.ts`; the missing coverage crosses those layers.

## RC-02 and RC-03: Render complete diffs and update them reactively
### Current path and root cause
`app/components/content/DiffBlock.client.vue:29` calls `parsePatchFiles(...).flatMap(({ files }) => files)[0]`, selecting only the first parsed file. Once that one file renders, line 75 hides the original full source because `state === 'ready'`. A two-file patch therefore presents only the first file and removes the fallback containing the second.  
Initialization runs only in `onMounted` at line 22. The sole watcher observes `wrapped`, not `source`. A live update replacing a diff node at the same rendered index can change the source prop while the existing diff instance continues displaying the previous patch. Copying from the enclosing code block then copies new source while the displayed diff can remain old.
### Minimal reproduction
Use one fenced `diff` code block with this complete source. Both filenames and both added lines must appear in the rendered result.

```diff
diff --git a/first.txt b/first.txt
--- a/first.txt
+++ b/first.txt
@@ -1 +1 @@
-old first
+new first
diff --git a/second.txt b/second.txt
--- a/second.txt
+++ b/second.txt
@@ -1 +1 @@
-old second
+new second
```

Keep the mounted block and replace `new second` with `latest second` in its source prop. The preview and copied source must now agree.
### Fix contract
Retain and render every parsed file in order, with explicit file identity. If a partial preview is ever necessary for a size limit, disclose that it is partial and expose the complete original source; never silently mark a subset as the full successful render.  
Rebuild or update diff instances when source changes. Dispose every old instance and obsolete asynchronous render before committing new state. Preserve the current wrap setting. Keep malformed/unrecognized diff source readable. Switching between valid and invalid source must not leave stale successful DOM behind. Preserve source text exactly for copy/export.
### Required verification

- A two-file patch renders both files, all hunks, and both distinguishing changes.
- A source prop update replaces the displayed change and releases prior instances.
- A rapid source update during the lazy import cannot commit an obsolete render.
- Valid → invalid → valid updates preserve readable fallback and remove stale output correctly.
- Wrapping still updates all file instances, and unmount cleans up every instance once.

`tests/unit/content-rendering/richTextRenderer.test.ts` currently mocks one returned file. Extend the discriminating behavior rather than adding another single-file source snapshot. Use at least one browser check with the actual installed `@pierre/diffs` renderer.

## RC-04: Forward media actions from all visible message locations
### Current path and root cause
`app/components/conversation/ConversationMessage.vue:71` forwards `RichTextRenderer`'s `openMedia` event into the main conversation path. `app/components/conversation/ConversationWorkEntry.vue:60` and `app/components/conversation/ConversationReasoning.vue:17` render the same rich content without listening for or forwarding that event. `ConversationWorkStream` declares only resize events, and `ConversationTurn` has no `openMedia` listener on that stream.  
As a result, image and Mermaid preview buttons inside progress messages and reasoning can appear enabled and render valid content, yet clicking their preview-open control has no effect on the shared viewer. Vue custom events do not bubble automatically through component boundaries.
### Fix contract
Forward the typed `MediaViewerItem` event through each actual path: progress renderer → work entry → work stream → turn → view, and reasoning renderer → reasoning component → work entry → work stream → turn → view. Preserve the existing final/user message route. Reuse the shared viewer rather than adding another modal.  
Restore focus to the original opener on close, preserve the work disclosure state, and retain the existing before/after resize behavior. Resolve assets through the repository as already intended.
### Required verification

- A cached image inside a progress message opens the shared viewer, and closing restores focus to its button.
- A Mermaid diagram inside reasoning can render Preview and then open the same shared viewer.
- Final assistant and user message media keep working.
- Test the actual `ConversationTurn`/work-stream hierarchy; isolated `RichTextRenderer` success cannot detect the missing intermediate listeners.

The present E2E fixture in `tests/e2e/content-rendering.spec.ts` exercises final-message media only.

## RC-05: Preserve Windows filesystem links before URL scheme classification
### Current path and reproduced result
`server/content/parseRichText.ts:156` calls `new URL(href)` before recognizing local filesystem paths. `C:/work/src/reader.ts:12` is parsed as a URL using scheme `c:`, which is unsupported, so `canonicalLink` returns `null`. The anchor conversion at line 325 then retains only its label children. `RichLink.fileReference` already recognizes drive paths, but the parser prevents those links reaching it.  
The audit ran `parseRichText('[reader](C:/work/src/reader.ts:12)')` using installed Node and jiti. The result was a paragraph containing only `{ type: 'text', text: 'reader' }`. The equivalent `[reader](/work/src/reader.ts:12)` retained a link node. Current tests only cover `file:///C:/...`.
### Fix contract
Recognize supported absolute Windows and UNC paths before treating the input as a generic URL. Preserve the destination and line/column suffix for the existing inert file-reference UI. Keep file path copy separate from source location display. Do not convert ordinary external links into local files, or turn copied local paths into automatic filesystem operations.  
Support both forward-slash Windows paths used by current Codex output and the existing file URL form. Define handling of backslashes, spaces enclosed by Markdown angle syntax, percent encoding, `:line:column`, and `#LlineCcolumn` consistently. Coordinate any new rich-node serialization fields or cache parser version with the ingestion/repository owner.
### Required verification

- Drive-path Markdown, file URLs, UNC paths, POSIX paths, and paths with spaces preserve the intended file path.
- Line and column suffixes display correctly and are excluded from the copied path.
- HTTP(S), mailto, and fragment links retain their expected behavior.
- A parser-to-renderer test confirms that the path reaches `.rich-file-reference`, not just that an intermediate string survives.

## RC-06: Repair footnote IDs and scope them per message
### Current path and reproduced result
`server/content/sanitizeSchema.ts:12` inherits the default rehype sanitizer settings. Remark's generated footnote IDs already contain the `user-content-` prefix; sanitization prefixes element IDs again. Link conversion at `server/content/parseRichText.ts:325` separately discards anchor attributes such as the reference's ID.  
For `Note[^1].\n\n[^1]: Body.`, the audit observed a reference URL `#user-content-fn-1` but a target list-item ID `user-content-user-content-fn-1`. The backlink URL is `#user-content-fnref-1`, but its corresponding reference ID is not retained. The body text exists, so the current test passes while navigation fails.
### Fix contract
Normalize generated footnote element IDs, forward reference URLs, and backlink targets as one operation. Preserve the necessary reference identity in the typed rich-text model/rendering path. Scope generated IDs to the message/document instance because a conversation contains multiple independent Markdown documents that can all use `[^1]`. Do not solve the doubled prefix while leaving cross-message ID collisions.  
Preserve general fragment-link behavior and accessibility attributes that are needed for the footnote relationship. Keep unrelated source anchors stable according to the chosen documented policy.
### Required verification

- The forward reference resolves to exactly one body target, and the backlink resolves to the original reference.
- Two messages each using `[^1]` navigate within their own message.
- Multiple references to one footnote all get valid return targets.
- Navigation works through the full rendered DOM, rather than a substring assertion that only checks body text.

The current coverage in `tests/unit/content/parseRichText.test.ts` only asserts the presence of “Footnote body”.

## RC-07: Handle linked media without losing resolver context
### Current path and reproduced prerequisite
`app/components/content/RichTextNode.vue:88` passes only the link node and favicon resolver into `RichLink`. The child recursion at `app/components/content/RichLink.vue:113` supplies only `node`; it loses `resolveAsset` and media events.  
The audit parsed `[![diagram](file:///C:/work/a.png)](https://example.com)` with a local path map assigning `C:\work\a.png` to `asset-a`. The resulting link correctly contains a media node with `source: 'asset'` and `assetId: 'asset-a'`. When rendered, that media node has no asset resolver and falls back to unavailable.
### Fix contract
Preserve resolver context and media interactions through linked content. Choose an explicit interaction model for linked images: following the link and opening an image preview must not produce invalid nested interactive controls or ambiguous click behavior. Forward media actions where a preview control is offered. Retain external-link destination access and a meaningful unavailable-media fallback.  
Consider whether shared render context is simpler than repeatedly widening props, but do not introduce a new abstraction solely for one call site if direct typed forwarding remains clear.
### Required verification

- A cached image nested in a Markdown link becomes visible with the expected local asset URL.
- Link navigation and any preview-open control perform distinct intended actions.
- Resolver failures remain readable; no direct remote image fetch is introduced.
- Link children containing formatted text continue to work.

## RC-08: Implement readable tool cards and chronological groups
### Current behavior and classification
`app/components/conversation/ConversationToolRow.vue:13` recognizes only `exec_command`, `spawn_agent`, `followup_task`, and `send_message`. Line 26 otherwise displays `${namespace ?? 'tool'}/${name}`. The header uses a status dot with no tool/category icon. A command preview exists only when input has a top-level string `cmd`. Input and output are otherwise exposed as raw technical JSON.  
`app/components/conversation/ConversationWorkStream.vue:77` groups adjacent file-change activities only. Other tools remain individual generic rows, so the normalized work stream lacks the requested mixed-tool summary and individual compact command/result treatment.  
This is primarily missing presentation work. The raw names and payloads are preserved; a fix should interpret them for display rather than discard them. `server/normalization/toolPairing.ts` and `server/normalization/nestedExec.ts` own evidence pairing and known wrapper derivation. Do not fabricate nested tool calls from dynamic source that cannot be resolved safely and deterministically.
### Fix contract
Implement a small typed presentation layer over canonical tool identities. For recognized tools, provide a readable action label, the relevant existing Phosphor icon, a concise subject/preview, and a status label understandable outside the protocol. Handle namespace-qualified names deliberately; do not rely on arbitrary substring guesses that conflate different tools. For unknown tools, retain a readable fallback with the exact raw identity in details.  
Match the coordinator's screenshot specification: a group can describe mixed operations, a command summary remains compact, each command can be expanded separately, and a completed successful result can read “Success”. Preserve distinct failed, cancelled, running, pending, and unknown states. Use actual normalized status/evidence; do not label every returned output successful.  
Group adjacent related entries while retaining original order and individual access. Do not regroup non-adjacent work across progress messages or reorder commands to create a prettier section. Preserve raw event provenance and copyable exact command/output. Surface genuinely useful output summaries, such as a shell result, without rendering the entire raw JSON as the main card. Keep failure text actionable and allow access to complete details.  
Review current nested-exec limitations separately from card labels. A dynamic wrapper that remains `functions/exec` is a conservative evidence fallback, not automatically a parser defect. Presentation can still explain that it is a script/orchestration call and expose source.
### Required verification

- Direct commands, known namespaced tools, subagent operations, mixed adjacent tools, and unknown tools have stable labels and correct icons/fallbacks.
- Grouping preserves a fixture's interleaved command → progress → tool order and keeps each child independently expandable.
- A success, nonzero exit, cancellation, running process, and unknown result have distinct accurate display states.
- Expanding one command does not expand every sibling; copy uses exact source, not the shortened summary.
- Browser acceptance uses the coordinator's screenshot reference for collapsed group, mixed group, expanded command, and successful result states.

Coordinate any shell-status normalization changes with the ingestion reviewer; do not hide an upstream status defect by inferring success in the card alone.

## RC-09 and RC-10: Make raw inspection lazy and useful
### Current behavior and root cause
`app/components/conversation/ConversationToolRow.vue:29` and line 30 compute formatted input/output. The raw payload subtree at lines 87–102 is always rendered inside native `<details>`, so opening the outer work disclosure mounts and formats every tool's payload even while individual technical disclosures remain shut. Native collapsed details hide content visually; they do not prevent Vue from evaluating interpolations or constructing that DOM.  
`app/components/conversation/ConversationInspector.vue:22` formats all `rawRecords`, and line 144 mounts the resulting text even with the raw-record disclosure closed. The related-activity, event-ID, and diagnostic sections beginning at line 131 display joined opaque IDs. They offer no labeled navigation into those records. Raw JSON has no highlighting, copy control, field navigation, or search.  
The timeline audit separately owns eager `agentWorkText` serialization and whole-turn costs. Fixing that caller does not remove the nested details allocation described here.
### Fix contract
Render and format technical/raw bodies on actual expansion. Release or retain already-open payloads under an explicit bounded policy; closing every detail must not accidentally trigger a full reformat loop. For very large payloads, show a bounded initial representation with clear access to the complete original source. A truncated preview must never be copied or exported as if it were the full original.  
Give the inspector readable related-entry labels and meaningful diagnostic messages with drill-in access. Keep exact IDs as secondary metadata. Provide straightforward copy/download of complete raw data and an effective way to inspect a large record; choose a focused feature set rather than building a generic developer-tools application.  
If JSON highlighting is added, apply it lazily and within a size policy. Do not pass multi-megabyte raw payloads through a full AST highlighter before the user asks to inspect them. Keep formatting/search local. Preserve non-JSON string tool output rather than forcing every result through an unhelpful JSON wrapper.
### Required verification

- With multiple large tool payload fixtures, opening the outer work group does not create their raw `<pre>` bodies or invoke the expensive formatter until a corresponding detail is expanded.
- Opening ordinary message info does not stringify/mount raw protocol records until the raw disclosure is expanded.
- Expanding one detail renders the correct complete or explicitly bounded preview, and the complete copy operation remains exact.
- A readable related-event control selects the correct record; diagnostic IDs are accompanied by actual available diagnostic information.
- Performance evidence distinguishes measured formatter/DOM work from speculative duration claims. Do not set a time threshold without a representative reproducible fixture.

## RC-11: Connect normalized attachments to a visible preview path
### Confirmed source gap and ownership
`app/components/conversation/ConversationMessage.vue` renders `message.body` but never consumes `message.attachmentIds`. `app/components/conversation/ConversationWorkEntry.vue:43` reduces a media activity to a text label using `mediaReferenceText`; its generic activity branch does not use `MediaBlock`. Thus a normalized user attachment can exist and be cached yet lack a visible image/media preview unless that same asset is separately referenced in Markdown.  
`server/export/prepareConversation.ts:86` collects media activities, discovers references from them, and uses those references to build the local asset-path map. A local path appearing only in Markdown does not establish an asset mapping by itself. This is separate from the event-forwarding bug: an attachment needs a renderable node/control before an open event can propagate.
### Fix contract
Coordinate with the normalization/media owner. Render supported normalized attachment IDs with their resolved type and status in the appropriate user message or activity position. Avoid duplicate cards where the same event/media is represented by multiple source forms. Preserve raw provenance and explicit unavailable/unsupported states.  
Determine whether Markdown-only local paths are an intended supported input before changing discovery. If they are supported, add them through the same controlled local media extraction and repository-resolution mechanism; do not make arbitrary browser filesystem paths load directly. Keep newly encountered tool-output/media formats separate from this already-normalized attachment display gap.
### Required verification

- A user image attachment with empty/text-only Markdown and a valid cached asset displays a preview.
- Supported audio attachments expose their player/download controls where appropriate.
- Missing and unsupported assets have readable status, not an apparently successful blank area.
- A generated asset already displayed in Markdown does not acquire a confusing duplicate from the activity list.
- Validate live and static repository paths with controlled local fixtures.

## RC-12: Investigate the reported syntax-highlighting symptom without inventing a cause
### What was actually verified
The audit called the installed parser with ordinary fenced TypeScript and Python. Both returned non-null Shiki trees containing `pre`, `code`, token `span` elements, preserved token colors, and source text. For example, TypeScript `const answer: number = 42` produced token colors including `#FF7B72` and `#79C0FF`. `server/content/highlightCode.ts:62` selects `github-dark-default`; the resulting `pre` style includes `background-color:#0d1117;color:#e6edf3`.  
`app/components/content/RichTextNode.vue:43` maps highlighted attributes, and its recursive branch preserves the highlighted mode. `CodeBlock.vue:72` renders the highlighted tree when present. These checks do not establish that every real message or browser/theme path is correct, but they rule out a blanket claim that the installed highlighter currently always returns plain text.  
The current highlighter is fixed to a dark theme, which is an appearance limitation rather than proof that token colors vanish. Raw HTML `<pre><code class="language-ts">` is a narrower input gap: `parseRichText.ts:308` reads only its private `dataLanguage` annotation, so it does not infer language from that conventional HTML class. Ordinary Markdown fences receive the private annotation and worked in the probe.
### Investigation/fix contract
Obtain one actual failing message's preserved Markdown, prepared rich tree, and rendered DOM/computed style. Check whether the source is a fenced block with a supported language, raw HTML, an inline snippet, a plain tool-output block, or a diff. Those are different render paths. Track language metadata through preparation/cache serialization and compare the real browser token style, including the active theme.  
If the defect is a preparation/cache compatibility issue, coordinate parser-version invalidation with the ingestion/repository owner. Do not merely add client highlighting over already-correct prepared trees. If the requested behavior is highlighting plain command output or tool JSON, implement that as the separate lazy presentation enhancement rather than claiming to repair fenced Markdown.  
Only change theme support if the reference/UI requirement warrants it. Preserve text and readable fallback for unknown languages. If adding raw HTML language inference, restrict it to recognized metadata and verify language precedence explicitly.
### Required verification

- A regression fixture representing the actual reported failure fails before its targeted fix and passes afterward.
- A parser-to-browser TypeScript/Python fixture asserts multiple distinguishable token colors and preserved source, not merely a `#` character somewhere in serialized JSON.
- Unknown-language blocks remain readable and copy exactly.
- Inspect active-theme readability if theme behavior changes.
- Do not close the broad user symptom solely because the existing highlighter unit test passes; record what specific failing shape was repaired or that the symptom remains unreproduced.

## Reusable parser reproduction command
This command runs only local parsing with installed Node/jiti and disables jiti's filesystem cache. It does not read Codex source data or fetch anything. Run from the repository root in PowerShell 7. The output captures the observed Windows-link/footnote shapes, linked-media prerequisite, and functioning ordinary highlighting.

```powershell
@'
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { fsCache: false });
const { parseRichText } = await jiti.import('./server/content/parseRichText.ts');
const samples = {
  windows: '[reader](C:/work/src/reader.ts:12)',
  unix: '[reader](/work/src/reader.ts:12)',
  footnote: 'Note[^1].\n\n[^1]: Body.',
  linkedImage: '[![diagram](file:///C:/work/a.png)](https://example.com)',
  ts: '```ts\nconst answer: number = 42\n```',
  python: '```python\nprint("hello")\n```',
};
for (const [name, source] of Object.entries(samples)) {
  const result = await parseRichText(source, { assetIdsByPath: new Map([['C:\\work\\a.png', 'asset-a']]) });
  console.log(name, JSON.stringify(result.document));
}
'@ | node_modules\node\bin\node.exe --input-type=module
```

## Suggested implementation order and handoff evidence
First fix lost/incorrect content paths: multi-file/reactive diff rendering, Windows links, scoped footnotes, and media event/resolver forwarding. Then fix favicon availability reactivity and attachment display, coordinating the repository and normalization boundaries where necessary. Implement the semantic tool view model and screenshot-driven cards after preserving chronology and status invariants. Make raw details lazy as part of those card/inspector changes, keeping the timeline audit's broader performance work aligned. Investigate the real highlighting failure independently throughout this work.  
Run the focused existing content/parser/rendering tests plus the new discriminating cases. Browser checks must cover actual multi-file diffs, cold cached-icon recovery without remote access, media opening from the work stream, and the requested collapsed/expanded tool states. The relevant existing files are `tests/unit/content/highlightCode.test.ts`, `tests/unit/content/parseRichText.test.ts`, `tests/unit/content-rendering/richTextRenderer.test.ts`, `tests/unit/content-rendering/mermaidMedia.test.ts`, `tests/unit/content-rendering/mediaViewer.test.ts`, `tests/unit/normalization/toolPairing.test.ts`, and `tests/e2e/content-rendering.spec.ts`.  
The fixer handoff must report changed files, which finding IDs were addressed, exact focused commands/results, browser evidence for the affected hierarchy, and remaining unverified real-data behavior. Do not mark all rich-content issues fixed based only on a mocked renderer suite or a successful general build. This audit itself executed only the local parser probes described above; it did not run the full suite or the proposed browser acceptance.
