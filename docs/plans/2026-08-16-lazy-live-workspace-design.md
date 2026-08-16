# Lazy live catalog, conversation workspace, and protocol-aware timeline design

Status: approved in conversation on 2026-08-16; written for final review before implementation.

## Goals

- Make `pnpm live` expose a useful 20-at-a-time conversation library without normalizing the whole Codex archive at startup.
- Materialize normalized conversation payloads only for visible, explicitly opened, or explicitly deep-searched sessions, with bounded memory and concurrency.
- Keep library state and the conversation list mounted beside a desktop conversation while preserving the narrow overlay interaction.
- Group root conversations into source-grounded Codex project folders and nest real subagent sessions under their parents recursively.
- Hide `codex-auto-review` guardian rollouts as standalone sessions while retaining their structured approval outcome and rationale with the reviewed tool activity.
- Derive real nested tool activities from `functions.exec` envelopes, render structured file changes as diffs, and keep a raw fallback when derivation is not provably safe.
- Present each turn as one prompt, one chronological collapsed work stream, and at most one final visible assistant response.
- Make minimap jumps work against unloaded target windows and center the tooltip on the active marker.

## Non-goals and boundaries

- Codex-owned files remain read-only and may change during a read. Only viewer-owned cache, generated output, tests, and source files may be written.
- The design does not enable network serving, remote APIs, or non-loopback binding.
- Static Pagefind remains exact and does not adopt progressive search semantics.
- The design does not eagerly retain normalized source graphs in memory and does not enable `retainLiveSources`.
- Guardian reasoning ciphertext is not rendered or interpreted. Only its explicit structured result is retained.
- Git staging, commits, branches, worktrees, and destructive operations remain user-owned.

## Chosen architecture

Use a persistent metadata catalog beside the existing normalized payload cache. Catalog construction reads discovery and bounded metadata; payload materialization reads and normalizes a complete selected rollout. The catalog is queryable before and independently of payload readiness.
Rejected alternatives:

- Continuing deferred full reconciliation still performs the full archive workload after the first HTML response and does not solve CPU, heap, or readiness time.
- An in-memory-only catalog would lose ordering, project topology, preparation state, and fast restart behavior, and would force the same metadata work on every launch.
- Treating placeholder `ConversationSummary` rows as fully normalized sessions would make zero counts and incomplete transcript filters indistinguishable from real data.

## Catalog data model

Add a cache migration that creates a strict `session_catalog` table and supporting indexes. A catalog row stores:

- stable session ID, selected source path, scope, source size/mtime, created and updated timestamps;
- metadata title/preview, cwd, Git branch/SHA/origin, pinned state, Codex section, model and reasoning hints;
- project ID and project-source classification;
- session kind (`root`, `subagent`, or `auxiliary`), parent thread ID, child count, agent path, nickname, depth, and auxiliary subtype;
- materialization state (`cold`, `queued`, `loading`, `ready`, or `failed`), last materialized revision, and a recoverable error message;
- a catalog revision that is independent from a normalized transcript revision.
  Existing `sessions`, `turns`, `messages`, `activities`, `raw_events`, FTS, asset, favicon, and source-manifest tables continue to own normalized payloads. Migration seeds catalog rows from existing normalized sessions so an upgrade does not discard a useful cache.
  The public list contract uses a distinct `ConversationListItem` containing metadata summary fields, project/topology fields, and materialization state. `ConversationSummary` remains the complete normalized session contract returned by `getSession`.

## Fast live startup

Startup performs these operations in order:

1. Open and migrate the viewer-owned cache, making previously persisted catalog and normalized rows immediately queryable.
2. Start independent source watchers so changes that occur during catalog refresh are queued.
3. Discover rollout paths and read cheap metadata sources: `session_index.jsonl`, `.codex-global-state.json`, and the retained validated state snapshot when available.
4. Upsert catalog rows. Use the rollout filename for identity and read only a bounded stable prefix through the first complete `session_meta` record when source kind, parent, or missing metadata requires it. Never scan transcript bodies during catalog refresh.
5. Mark the library ready after the catalog transaction and start a non-blocking fresh state snapshot. Apply its richer cwd, Git, section, project, and spawn-edge metadata in a later catalog transaction.
6. Start periodic catalog reconciliation. Cold changed sessions update only their catalog fingerprint/metadata and become `cold`; ready/hot changed sessions enter the serialized payload reconciliation queue.
   The initial reconciler path must not invoke `SessionCacheUpdater.update`, rich-content preparation, media extraction, favicon resolution, transcript FTS writes, or raw-event writes for every discovered rollout.

## Visibility-driven materialization

Add repository operations for catalog/project listing and preparation. Live mode exposes a loopback-only batch preparation endpoint; static mode implements preparation as an immediate no-op with `ready` results.
The library requests at most 20 root sessions per folder/page. Each rendered row is observed with `IntersectionObserver`. Newly visible cold IDs are coalesced into one batch and sent to a deduplicated single-concurrency preparation queue. Rows show a lightweight skeleton/progress state while their transcript cache is built.
An explicit open or deep link receives priority over speculative visible-row work. Session summary, navigator, turn, inspector, and search endpoints call `ensureMaterialized(id)` so a valid cold catalog row is prepared exactly once before the payload query. Concurrent callers share the same promise.
Preparation validates a stable source read, normalizes one selected source, enriches protocol relationships, prepares rich content, transactionally replaces that session payload, and marks the catalog row `ready`. Failure preserves the catalog row and last good normalized payload, marks the new attempt `failed`, and exposes a row/session retry action.

## Progressive live search

The approved live search behavior is progressive:

- Always search catalog title, preview, cwd, project, model hints, and other metadata for all catalog rows.
- Search exact prompt/response/activity text through FTS only for materialized sessions.
- Clearly label result coverage and provide `Search unloaded conversations`, which explicitly queues cold root sessions in the selected scope and streams refreshed exact results as batches complete.
- Cancelling or changing the query cancels queued deep-search ownership without corrupting already completed cache rows.
  Automatic archive-wide materialization on every query is intentionally not used. Static Pagefind continues to search every exported transcript exactly.

## Project folders

Read Codex project definitions from `.codex-global-state.json` rather than crawling repositories. The observed profile currently defines `codex-usage-tool`, `miniproto`, `PZP-AI`, `unzip-bot`, `codex-app`, `raycast`, and `codex-sessions-viewer`.
Map a session to the project whose normalized root path is the longest directory-boundary prefix of its cwd. If no declared project matches, group by normalized Git origin. If no origin exists, group by normalized cwd. Otherwise use `No project`.
Project descriptors contain stable ID, display name, source (`codex`, `git`, `cwd`, or `none`), root/origin hint, and root-conversation counts by scope. The library loads project descriptors first and loads 20 root conversations only when a folder is expanded. Folder expansion, pagination cursor, row scroll, filters, and selected session persist across route navigation.

## Persistent desktop workspace

Move the library controller and rail from the index-only component into the default layout for `/` and `/session/**`. The route slot becomes the canvas.

- Desktop keeps the rail visible beside the library intro or conversation canvas and highlights the selected root or child session.
- Narrow layouts keep the existing modal rail, scrim, Escape handling, focus return, and close control.
- Settings remains outside the workspace rail.
- Shared route-level state applies resolved `useAsyncData` payloads reactively instead of snapshotting an unresolved value. Returning from a session therefore cannot reset counts to zero.
- Active/archived tab counts count root conversations only. Nested subagents and auxiliary guardian rollouts do not inflate the conversation total.

## Session topology and subagent presentation

Classify rollout sources from `session_meta.payload.source`:

- `source.subagent.thread_spawn` is a real subagent and supplies parent thread ID, depth, agent path, nickname, and role.
- `source.subagent.other = "guardian"` is auxiliary approval-review evidence.
- Other sources are root conversations unless a validated parent edge establishes subagent topology.
  Merge state `thread_spawn_edges` with rollout parent metadata. Prefer explicit rollout evidence for the child, retain state status, and reject cycles before exposing the tree. A parent may itself be a child; ancestry and breadcrumbs remain recursive.
  Root conversations are the only top-level folder rows. Expanding a root or subagent exposes its children lazily. Opening a child keeps the project/library rail and shows a parent-chain breadcrumb.
  For child conversation content, suppress leading environment/bootstrap messages such as `<recommended_plugins>`, permission scaffolding, and inherited workspace context when they are protocol setup rather than the delegated task. Treat the incoming parent-to-child agent message as the child assignment when present.
  In a parent timeline, merge `sub_agent_activity` started/interacted events and `response_item:agent_message` updates into source-ordered subagent activities enriched with child ID/path/nickname/status. Agent rows link to the child session; progress and messages remain visible inside the parent's work stream.

## Guardian approval evidence

Auxiliary guardian rollouts never appear in project folders, scope counts, model filters, model labels, or standalone session routes.
When a parent session is materialized, parse linked guardian turns into bounded approval records containing reviewed action, outcome, risk level, rationale, and timestamp. Match a record to a parent tool activity only by a canonical reviewed-action/tool-input match plus monotonic order. Never attach by time proximity alone when more than one candidate is plausible.
If a guardian result is valid but cannot be matched unambiguously, retain it as an unassociated approval-review activity in the parent work stream. Malformed guardian output remains available only in inspector raw evidence and produces a diagnostic.
The visible tool result may show `Approved` or `Denied` with the rationale. Encrypted guardian reasoning and the repeated embedded parent transcript are excluded from conversation prose and search.

## Protocol-aware nested tool derivation

Treat `custom_tool_call` named `exec`/`functions.exec` as an envelope. Parse its JavaScript with a small non-executing structural parser; never use `eval`, `Function`, dynamic import, or execute source text.
Extract ordered direct `tools.<name>(object)` calls, including calls inside `Promise.all`. Pair their output with outer `custom_tool_call_output` content blocks by stable emitted order and correlate structured sibling protocol events within the outer call/output byte interval.
Derivation rules:

- Each nested `exec_command` becomes its own tool activity with a `Ran command` label, command, status, duration, output, and error.
- Each nested `apply_patch` uses `patch_apply_end.changes` as authoritative structured evidence. Add/update/delete/move files retain path, change kind, unified diff or created content, and added/removed line counts.
- Consecutive file-change activities render as one `Edited X files` or `Created X file(s)` disclosure. It expands to individual file rows; a file expands through the existing diff renderer.
- Other recognized nested tools become ordinary named tool activities.
- The outer envelope is omitted from the ordinary work list only after every visible derived child is losslessly associated. It remains reachable through inspector/raw evidence.
- If parsing or pairing is incomplete, show the original raw `tool/exec` activity and do not invent children.

## Chronological turn model

Extend the normalized turn with all steering messages plus a stable `entryOrder` reference list. Keep the first visible user message as `userMessage` for compatibility; store later user messages as `steeringMessages`. Keep assistant messages and activities as typed payloads.
Normalization builds one source-offset order over prompt/steering messages, assistant messages, reasoning blocks, tools, file changes, subagent events, plans, status, media, and compaction. The turn records the final assistant message ID separately.
Presentation rules:

- Render the first user message as the prompt.
- Render only the last assistant message as the visible response.
- Put every other ordered entry into one top-level disclosure labeled `Worked for <formatted duration>`. The disclosure is collapsed by default and contains steering user messages, intermediate assistant commentary, reasoning, tools, agent work, and statuses in source order.
- If there is no final assistant message, keep all work in the disclosure and show no fabricated response.
- Copy-agent-work follows the same chronological order.
  Reasoning normalization creates one activity per protocol summary/content entry. It suppresses only provable mirrored protocol copies, never merges separate blocks merely because their text matches. Reasoning renders `body` through the existing sanitized Markdown renderer and never displays `Encrypted source retained`.
  Rich-content preparation, cache message writes, FTS indexing, inspectors, static payload generation, and output verification include steering messages and the new ordering metadata.

## Minimap behavior

Distant selection remains repository-targeted; users do not need to preload every earlier chunk. A target jump owns the latest request, exposes pending/error state on the selected marker, and uses a smaller live target window than ordinary adjacent browsing.
Before applying a replacement target window, reset stale virtualizer measurement and scroll-offset state. After application, measure, scroll to the exact index, and perform bounded frame settling against the rendered turn. A failed target leaves the previous window usable and offers retry.
Add a real static-browser regression with more than 20 turns, large dynamic rows, and a distant click before any manual upward scroll. Preserve the existing keyboard and focus-restoration behavior.
Measure the active minimap button center relative to the minimap container after focus, hover, scrolling, and resizing. Bind the tooltip center to that measured coordinate instead of fixed `50%` positioning.

## Concurrency, invalidation, and errors

- Catalog refresh, payload materialization, and rich-content writes share one serialized SQLite writer.
- Visible preparation has concurrency one; open-session work has priority and shares in-flight ownership by session ID.
- Catalog changes publish `library.updated`; ready payload changes also publish `session.updated`. Cold watcher changes do not trigger transcript normalization.
- State/project/spawn-edge updates refresh affected catalog rows and visible topology without normalizing unrelated transcripts.
- Latest-wins request generations remain mandatory for library filters/pages, target jumps, deep search, inspector loads, and live session refresh.
- Every background promise has an owned catch path. The UI preserves last-good rows/turns and exposes retry instead of becoming an indefinite skeleton.

## Compatibility and migration

- Bump the cache schema and normalization parser version. Migrations are viewer-cache-only and never touch Codex databases.
- Seed the new catalog from existing normalized summaries, then reconcile source metadata asynchronously.
- Static list items are always `ready`; static export includes project descriptors and topology derived during export.
- Generated payload schemas are versioned where ordering/topology fields are added. A new export is required to expose new protocol features; source ingestion remains backward-compatible with older rollout shapes.

## Verification and acceptance

Use test-first increments and retain the existing custom TypeScript ownership boundary: pure non-default tests/scripts belong to `tsconfig.custom.json`; Nuxt-owned app/server imports remain under Nuxt type-check projects.
Required focused coverage:

- catalog migration/seeding, metadata-prefix bounds, project longest-root matching, cycle-safe parent topology, guardian classification, and auxiliary exclusion from counts/models;
- startup proves zero transcript normalizations before explicit prepare, 20-row pagination, visible-ID batching, concurrency one, open priority, deduplication, watcher cold/hot behavior, and retry/last-good preservation;
- offline route return applies settled counts and retains pages/filters/folder state;
- nested exec parsing covers one patch, created files, multiple consecutive edits, three parallel commands, malformed fallback, output ordering, and approval association/ambiguity;
- multiple reasoning entries remain distinct, Markdown renders, steering and intermediate responses interleave, only the last assistant response is exposed, and encrypted-label text is absent;
- desktop rail persistence, narrow focus behavior, nested subagent navigation, distant static/live minimap jumps, pending/error state, dynamic row measurement, and tooltip-marker centering;
- static Pagefind parity, generated-output validation, local-only networking, accessibility, and source read-only invariants.
  Performance acceptance:
- first live library response performs catalog work only and never waits for full reconciliation;
- first list page returns no more than 20 root conversations;
- catalog prefix reads are explicitly byte-bounded and do not scale with transcript length;
- visibility preparation never has more than one source normalization resident concurrently;
- bounded live repository reads remain faster than full-session hydration and no path reintroduces full-archive retained graphs.
  Final gates remain direct PNPM commands: focused Vitest projects, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, full tests, Playwright, production build, representative static export/verification, and an elevated real-data live smoke when the sandbox cannot access the viewer cache. The known real 576-session indexed Pagefind export remains unapproved and must not be launched.
