# Codex Sessions Viewer

Browse your local Codex conversations in a read-only web app. Open active and archived chats, search transcripts, inspect tool calls and raw records, view attachments, or export a static archive.  
The viewer reads your Codex home without changing it. It stores its own cache, settings, and exported files separately.

## Get started

You need Node.js 26.x and PNPM 11. Windows is the primary test platform, with support for macOS and Linux.  
From the repository directory:

```pwsh
pnpm install --frozen-lockfile
pnpm build
pnpm live
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The server listens on the loopback interface.  
To use another Codex home or port:

```pwsh
pnpm live --codex-home "C:\Users\you\.codex" --port 3001
```

The viewer selects the Codex home in this order: `--codex-home`, saved viewer settings, `CODEX_HOME`, then `~/.codex`. You can also change it in Settings.

## Browse and search

The library groups chats by project and section, with separate active and archived views. Open a chat to load its recent history, then load older turns as needed. Expand delegated agents below their parent chat.  
Search matches chat titles and project names by default. Choose **Search transcript content** to search indexed text. Choose **Search unloaded conversations** to index the remaining chats. You can cancel indexing. Results cover only the content indexed so far.  
Conversations include reasoning, tool calls, code, diffs, tables, Mermaid diagrams, and available attachments. Use the turn navigator to move through a chat and Info to inspect its recorded evidence. Theme, timestamps, wrapping, and other display preferences live in your browser.

## Export an offline archive

```pwsh
pnpm export --offline
pnpm verify:output
pnpm offline
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Export includes the static site, searchable transcripts, Markdown downloads, and available local media. Serve it over HTTP, opening `index.html` through `file://` does not support search or history loading.  
Export writes to `.output/public` and replaces the previous archive after generation succeeds. The offline server serves that directory on `127.0.0.1` without reading your Codex home.

| Export option         | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `--codex-home <path>` | Read another Codex home                                                 |
| `--media-root <path>` | Allow attachments from this directory (repeat for multiple directories) |
| `--output <path>`     | Write the archive to another directory                                  |
| `--offline`           | Skip remote favicon and website-preview requests                        |
| `--link-previews`     | Fetch website previews for links (ignored with `--offline`)             |
| `--no-index`          | Skip full-text search to reduce export work and memory use              |
| `--force`             | Reprocess rollouts instead of reusing cached results                    |

For a large collection, try `pnpm export --offline --no-index` first. Pagefind indexing can require substantial memory. Check an indexed export on a representative collection before exporting the entire archive.  
To keep the live viewer open, serve the archive on another port with `pnpm offline --port 3001`. If you use `--output`, serve that directory with an HTTP server bound to the loopback interface.

## Local data and network access

Your Codex home contains the source conversations. The viewer uses optional Codex metadata for titles, project grouping, and other library details. Missing metadata does not prevent it from reading available rollouts.  
The cache and exported archive contain private conversation text, local paths, raw records, and copied attachments. Review their contents before sharing them. The viewer's local server and `noindex` directives do not protect a copy that you publish elsewhere.  
Live mode fetches missing favicons by default. Website previews are off by default and have a separate setting. If enabled, previews load after you hover over or focus a link. Cached icons and previews remain available when fetching is disabled. Remote enrichment requests enforce address, size, redirect, and timeout limits.  
Use `pnpm export --offline` to prevent network requests during export. Exported pages load their code, fonts, search index, and copied media from the archive. Opening an external link requires your action. The viewer has no telemetry.  
Local attachments must be inside a trusted media directory. The default is `<codex-home>/attachments`. Explicit `--media-root <path>` options replace that default. Repeat the option to list every directory you want to trust when running `pnpm live`, `pnpm dev`, or `pnpm export`.

## Storage

| Platform | Configuration                                                     | Cache                                                             |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\codex-sessions-viewer\config.json`                | `%LOCALAPPDATA%\codex-sessions-viewer\cache\viewer.sqlite`        |
| macOS    | `~/Library/Application Support/codex-sessions-viewer/config.json` | `~/Library/Caches/codex-sessions-viewer/viewer.sqlite`            |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/codex-sessions-viewer/config.json` | `${XDG_CACHE_HOME:-~/.cache}/codex-sessions-viewer/viewer.sqlite` |

The cache directory also holds metadata snapshots, decoded rollouts, cached media, favicons, previews, and export staging files. In the repository, `.generated`, `.output`, and `.output-live` contain generated files.  
To rebuild the cache or remove an export, stop the viewer and delete the specific viewer-owned cache or output directory. Keep your Codex home intact.

## Development and checks

```pwsh
pnpm dev
```

Development mode supports hot reload and the same `--codex-home`, `--media-root`, and `--port` options as `pnpm live`. To serve production output after source or dependency changes, run `pnpm build` again before `pnpm live`. If you set `CODEX_VIEWER_BUILD_OUTPUT`, use the same value for both commands.

| Command                                 | Checks                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm verify:source`                    | Nuxt preparation, formatting, types, lint, tests, integration and performance suites, and coverage |
| `pnpm verify:release`                   | Source checks, production build, and browser tests                                                 |
| `pnpm verify:output [--output <path>]`  | Exported payloads, routes, assets, manifests, and search runtime                                   |
| `pnpm run doctor [--codex-home <path>]` | Source discovery, metadata, cache state, and parser diagnostics                                    |

Before a release, run `pnpm verify:release`, export a representative Codex home, and run `pnpm verify:output` against that export. Doctor reports what it finds, output verification checks the generated archive's integrity.  
Source code lives in `app/` (browser UI), `server/` (ingestion, cache, and APIs), `shared/` (contracts and algorithms), and `scripts/` (commands). Tests live in `tests/`, including Node, Nuxt, HTTP, Pagefind, performance, and Playwright suites.

## Troubleshooting

### A chat keeps loading

Run `pnpm run doctor` and check the selected Codex home and parser diagnostics. A rollout may be incomplete or changing while Codex writes it. Check the path in Settings or restart with `--codex-home <path>`.

### Offline search is unavailable

An export made with `--no-index` has no full-text search. Otherwise, run `pnpm verify:output` to check the Pagefind files and archive contents, then export again if needed.

### Windows tests fail in `fs-event.c` or SQLite cannot open a temporary database

Set `TEMP` and `TMP` to the existing `%LOCALAPPDATA%\Temp` directory using its full path (avoid an 8.3 alias), run `pnpm exec nuxt prepare`, and retry. Deeply nested temporary paths can exceed SQLite's Windows path limit. Keep Pagefind tests isolated from parallel files.

### A build reports `readlink` access denied

A managed sandbox can block symlink inspection under the user profile during Nitro tracing. Retry the build in a normal elevated shell.

## License

[MIT](LICENSE)
