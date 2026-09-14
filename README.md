# Codex Sessions Viewer

Codex Sessions Viewer is a local, read-only Nuxt application for browsing Codex conversations. It discovers active and archived JSONL rollouts, preserves unknown protocol records for inspection, enriches them with optional Codex metadata, and presents the same repository contract through a live loopback server or a fully generated static archive.

The viewer never writes, renames, locks, migrates, or deletes anything under the selected Codex home. Its SQLite cache, configuration, generated Markdown, copied media, favicons, and static output are viewer-owned derivatives stored elsewhere.

## Requirements

- Node.js 26; the project pins Node 26.8.1 for its commands
- PNPM 11.26.0
- Windows, macOS, or Linux; Windows is the primary acceptance platform

Install the exact locked dependencies:

```powershell
pnpm install --frozen-lockfile
```

PNPM can provision the Node runtime declared by the package when the active system Node does not satisfy the project contract.

## Quick start

Build the application, then start the live viewer on the loopback interface:

```powershell
pnpm build
pnpm live
```

Then open `http://127.0.0.1:3000`. Startup builds only a byte-bounded metadata catalog; it does not normalize every transcript. Project folders and root-conversation counts become available from that catalog, each list page contains at most 20 roots, and one visible or explicitly opened cold session is prepared at a time. The persistent desktop library remains usable while an opened conversation shows its loading skeleton.

Build an offline archive without making favicon requests:

```powershell
pnpm export --offline
pnpm verify:output
pnpm offline
```

Then open `http://127.0.0.1:3000`. Static output requires this local HTTP server; direct `file://` loading is not supported because payload chunks and Pagefind are fetched from the local origin.

## Commands

### Live viewer

```powershell
pnpm live [--codex-home <path>] [--media-root <path>] [--port <number>]
```

The command runs the production server from `.output-live/server/index.mjs`; run `pnpm build` again after changing application source or dependencies. If `CODEX_VIEWER_BUILD_OUTPUT` selects another build directory, use the same value for both commands. The server binds only to `127.0.0.1`. It uses cached data immediately when possible, watches active and archived rollouts, coalesces changes, and broadcasts local invalidations over SSE. A Codex JSONL file may be mid-append; only complete stable records are exposed. Visible preparation and explicit opens share a serialized priority queue, so full transcript normalization never fans out across the archive. Repeat `--media-root` to trust more than one attachment directory.

Library folders are derived from Codex project metadata, git origins, and working directories. Root conversations appear directly in their project; subagents are nested below their parent at any depth. `codex-auto-review` rollouts are auxiliary approval evidence rather than conversations: they are excluded from counts, routes, folders, and model filters, while an unambiguous allow/deny result remains attached to the reviewed tool call.

Normal live search checks ready cached transcripts and catalog metadata first. If results may exist in cold sessions, the UI offers an explicit progressive deep search. That operation prepares cold sessions serially, reports progress, can be cancelled, and never turns ordinary typing into an archive-wide scan.

The Codex-home precedence is the explicit CLI argument, viewer configuration, `CODEX_HOME`, then the platform default `~/.codex`.

### Static export

```powershell
pnpm export [--codex-home <path>] [--output <path>] [--offline] [--force] [--no-index]
```

The default output is `.output/public`. Export writes into isolated staging directories and atomically publishes the completed site so a failed generation does not replace the previous good archive.

- `--offline` disables all remote favicon attempts. Conversations, links, local media, and cached content still export.
- `--no-index` skips Pagefind and disables full-text search in the static site. Metadata browsing remains available.
- `--force` retransforms every discovered rollout instead of reusing a matching source fingerprint.
- `--output <path>` selects another viewer-owned publication directory.

Pagefind creates one flat search record per turn and can require substantial memory for very large archives. Use `--no-index` when full-text search is unnecessary or when first validating a large collection, then test indexed export on a representative Codex home before scaling it up.

Static turn payloads are bounded by both turn count and an approximate byte budget, with an explicit per-turn chunk map for exact distant navigation. A single unusually large turn remains indivisible, but unrelated large turns are no longer aggregated into the same JSON payload. Prerendered session routes ship the conversation skeleton and fetch their selected chunk after hydration, avoiding duplication of multi-megabyte tool output in session HTML.

### Offline server

```powershell
pnpm offline [--port <number>]
```

This server reads `.output/public`, binds only to `127.0.0.1`, accepts `GET` and `HEAD`, prevents path escape after real-path resolution, and applies the same local-only content, framing, MIME, referrer, and indexing policy as the live viewer. The CSP permits only same-origin application code and connections plus the inline Nuxt bootstrap, Vue-managed styles, local fonts, and local/data/blob media required by the UI; it does not allow remote origins or evaluated code. The server never starts live ingestion or favicon fetching.

### Diagnostics

```powershell
pnpm run doctor [--codex-home <path>]
```

Doctor is read-only. It reports discovered active and archived sources, catalog roots/subagents/auxiliaries, cold/queued/loading/ready/failed materialization counts, normalized payloads and parser diagnostics separately, state-snapshot availability, static-output structural presence, and whether Pagefind is present or disabled. Doctor does not check publication integrity; run `pnpm verify:output` for the authoritative semantic verification.

### Generated-output verification

```powershell
pnpm verify:output [--output <path>]
```

The verifier checks the publication boundary independently of the exporter. It rejects linked or non-regular files, invalid manifests and schemas, mismatched session summaries, navigators, turn chunks, inspector targets, missing Markdown or prerendered routes, broken asset/favicon hashes and sizes, incomplete Pagefind runtimes, and external automatic resources referenced by generated HTML or CSS. It scans one session or content file at a time so verification remains bounded on large archives.

## Data and privacy boundaries

Codex rollouts and metadata are immutable inputs. JSONL conversation content is authoritative; `session_index.jsonl`, global state, and the Codex SQLite database are optional enrichment and never gate a readable rollout. SQLite enrichment is copied into a stable viewer-owned snapshot before it is read.

The viewer cache and generated output contain conversation text, local paths, git metadata, raw protocol evidence, copied local media, and downloadable Markdown. Treat both with the same sensitivity as the original Codex home. Do not publish, synchronize, or serve them on a non-loopback interface unless you have independently reviewed and intentionally accepted that exposure.

There is no telemetry, account integration, remote sharing, session editing, or source mutation. Generated pages and the offline server carry `noindex, nofollow, noarchive`, but those directives are not access control.

## Favicon and network behavior

Favicon enrichment is the only automatic feature allowed to use the network. Live mode may fill missing viewer-cache favicons in the background, and export may fetch them unless `--offline` is present. Requests are bounded by type, size, timeout, redirect, DNS, and public-address checks; loopback, private, link-local, reserved, and redirect-pivot targets are rejected. A favicon failure degrades to a local fallback and never makes its conversation unavailable.

The generated site performs no external automatic runtime requests. Fonts, application bundles, Pagefind, exported media, and resolved favicons are local. Remote links and uncached remote-media placeholders remain inert links that require an explicit user action.

## Locations

Viewer configuration and cache locations follow the platform conventions below:

| Platform | Configuration                                                     | Cache                                                             |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\codex-sessions-viewer\config.json`                | `%LOCALAPPDATA%\codex-sessions-viewer\cache\viewer.sqlite`        |
| macOS    | `~/Library/Application Support/codex-sessions-viewer/config.json` | `~/Library/Caches/codex-sessions-viewer/viewer.sqlite`            |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/codex-sessions-viewer/config.json` | `${XDG_CACHE_HOME:-~/.cache}/codex-sessions-viewer/viewer.sqlite` |

Generated state snapshots, cached media, cached favicons, and private export staging live below the same viewer cache root. Repository-local `.generated`, `.output`, and `.output-live` directories are viewer-owned build products and are ignored by Git.

Presentation preferences such as theme, disclosure defaults, timestamps, code wrapping, live follow, and minimap visibility are stored only in browser local storage under `codex-sessions-viewer:presentation:v1`.

## Development and verification

The source follows Nuxt 4 ownership boundaries: browser code in `app/`, server-only code in `server/`, universal contracts and algorithms in `shared/`, Jiti command entrypoints in `scripts/`, and verification in `tests/`.
Start development with hot reload using `pnpm dev`. It accepts the same `--codex-home`, repeatable `--media-root`, and `--port` options as `pnpm live`, and binds to the same loopback interface. `pnpm live --dev` is equivalent.

Run the normal source checks with:

```powershell
pnpm verify:source
```

For complete local release readiness, including the production build and browser checks, run:

```powershell
pnpm verify:release
```

The composed gates stream each child command's output, stop at the first failure, and run in this order:

1. `pnpm exec nuxt prepare`
2. `pnpm format:check`
3. `pnpm typecheck`
4. `pnpm lint`
5. `pnpm test`
6. `pnpm test:integration`
7. `pnpm test:performance`
8. `pnpm coverage`
9. `pnpm build` (release gate only)
10. `pnpm test:e2e` (release gate only)

`pnpm verify:output [--output <path>]` remains separate: it verifies the semantic integrity of a newly generated representative publication, while `doctor` reports only structural presence. Do not treat an arbitrary stale `.output` directory as release evidence.

Vitest separates Node, Pagefind, performance, UI, and Nuxt-owned suites. Pagefind integration is intentionally isolated from parallel files on Windows because its own atomic index rename can collide across workers. `tsconfig.custom.json` type-checks non-default entrypoints and tests; Nuxt remains the owner of application, server, and shared source typing.

## Troubleshooting

### The live page is preparing for a long time

The initial HTML should still show the application shell and loaders, but the library should not wait for full transcript reconciliation. Run `pnpm run doctor` in another terminal and compare the catalog counts with the normalized-payload count. A malformed or changing source is isolated; a single favicon or optional metadata failure should not stop the library. A conversation row may remain cold until it enters the viewport, and opening it promotes that one session ahead of background visible preparation.

If the selected Codex home is wrong, start with `pnpm live --codex-home <path>` or update it from Settings. The server validates the new directory before changing watcher context.

### Windows reports `node:sqlite` as external

Nuxt may print a build-time warning that the `node:sqlite` built-in is external. Node 26 supplies that built-in at runtime; the warning alone is not a cache failure. Confirm the active runtime with `pnpm node --version` and use `pnpm run doctor` to inspect the actual cache state.

### Windows tests abort in `fs-event.c` or show short TEMP paths

Some Windows profiles expose `%TEMP%` through an 8.3 alias while file watchers report the long path. Point `TEMP` and `TMP` to an existing long-form directory such as the repository `.nuxt` directory for that shell, rerun `pnpm exec nuxt prepare`, and retry the failing command. Keep Pagefind tests isolated rather than disabling parallelism for the complete suite.

### Build or prerender fails on `readlink` under the user profile

A managed sandbox can deny symlink inspection outside the repository during Nitro tracing even though the repository is valid. Re-run the exact build in a normal elevated shell before diagnosing source code from that error.

### Export uses excessive memory or reports `Invalid string length`

Update to the current implementation first: message inspectors retain only their own raw-event evidence while turn inspectors retain the complete turn evidence. For a very large collection, validate `pnpm export --offline --no-index` first. Indexed Pagefind export is a separate resource boundary; use a representative Codex home and monitor memory before attempting the complete archive.

### Offline search is unavailable

Run `pnpm run doctor`. Search is intentionally disabled after `--no-index`; otherwise the output must contain a complete `pagefind/` runtime. Run `pnpm verify:output` to distinguish a missing index from a broader publication inconsistency.

### Cached or generated data must be removed

Stop the live/offline process first, confirm the exact viewer-owned path from the table above or the command output, and remove only that cache or generated-output directory. Never target the Codex home. The viewer can rebuild its own cache and export, but deleted derived data is not recoverable unless backed up.
