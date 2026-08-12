# Codex Sessions Viewer

Read local Codex conversations in a polished Nuxt interface without modifying, renaming, locking, or deleting Codex-owned files. The project is local-only, SSR-capable, and designed to export a fully offline static archive.

## Requirements

- Node.js 26.7 or newer on the Node 26 release line
- PNPM 11.21.0

## Setup

```powershell
pnpm install
```

PNPM resolves the declared Node runtime when the active Node installation does not satisfy the project contract.

## Commands

### Live

```powershell
pnpm live
```

Starts the Nuxt SSR development server on `127.0.0.1`. Source ingestion and refresh are added by later implementation tasks.

### Export

```powershell
pnpm export
```

Generates the static Nuxt output in `.output/public`. Session ingestion, Markdown generation, media copying, and offline search are added by later implementation tasks.

### Offline

```powershell
pnpm offline
```

Serves the generated static output on `127.0.0.1` without live data updates or network fetching.

### Doctor

```powershell
pnpm run doctor
```

Reports the current Nuxt environment. Codex-home discovery and read-only cache diagnostics are added by the next foundation tasks.

## Development checks

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
```

The source directories follow Nuxt 4 ownership boundaries: browser code in `app/`, server-only code in `server/`, universal code in `shared/`, command entrypoints in `scripts/`, and verification in `tests/`.
