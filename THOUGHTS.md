# THOUGHTS — Things Heard, Observed, Unclear, Guessed, Hacked, Tracked, or Suspected : A living document about non-trivial details

This document will serve as a scratchpad for things encountered during development.  
You will find here notes about undocumented stuff, questions about implementation, random ideas that don't fit quite yet the PLAN, ...  
Developpers and Agents alike can write here freely so knowledge never gets lost. Some things can stay in a conversation, in an LLM inner Chain-of-Thoughts, in reasoning, ... but what if we start a new thread ? Everything gets lost. `THOUGHTS.md` fixes that, by providing a persistent, searchable record of non-trivial details that Agents and Developpers can write into and refer to.  
Information already present elsewhere (README, AGENTS, PLAN, PROGRESS, plans folder, docs, code & comments, ...) shouldn't be duplicated here.

## 2026-08-13 — Unknown model — Codex Desktop — "Implement Plan Task 3 ingestion boundaries"

- On Windows, one Chokidar v5 instance combining existing session directories with exact metadata paths that do not yet exist can suppress directory change events; keep the active-session, archive, and exact-metadata watchers independent unless a replacement is verified against the live append test.
- Nuxt's production SSR build generated an unresolved `entry-styles-*.mjs-!~{...}~.js` placeholder when the custom Rolldown `manualChunks` function forced Vue/Nuxt packages into vendor chunks; the build passed after removing that function, so do not restore equivalent chunking without verifying `pnpm build` and `pnpm export`.
- Nuxt's experimental `buildCache` can prevent Vitest projects created through `defineVitestProject` from resolving: restoring a cached Nuxt build may skip the `vite:configResolved` hook, so Node exits successfully without collecting tests. Keep `experimental.buildCache: false` in the Vitest-only Nuxt overrides unless a later Nuxt/test-utils version is proven to emit the hook on cache restoration.
- Validate that a file-backed cache is exactly an unlinked `viewer.sqlite` before constructing `DatabaseSync`: connection setup such as `journal_mode=WAL` can mutate a database before migrations get a chance to reject it, and a correctly named hard link can otherwise target Codex's `state_5.sqlite`.
- Rollout turn, message, activity, and raw-event IDs are session-local and repeat across transcripts, so viewer-cache keys and foreign keys must remain composite on `(session_id, id)` even when a fixture set appears globally unique.
- Persist source mtime from the same verified stable-read observation used for the exact hash, then compare it with the post-read path observation; taking mtime only from a later stat can pair an old hash with a newer same-size rewrite and incorrectly trust it on the next scan.

## 2026-08-13 — Unknown model — Codex Desktop — "Implement Plan Task 6 rich content and favicons"

- A successful favicon-provider HTTP status is not sufficient validation: providers differ between a 404 image and a 200 tiny placeholder for an unknown domain. Probe each provider with a deterministic nonexistent host, compare the decoded image hash with the candidate, and fall through to the site's declared icons and `/favicon.ico` when they match.
- Keep IPv4 and IPv6 private-address ranges in separate Node `BlockList` instances. Mixing the IPv6 `::ffff:0:0/96` mapped-address range into the IPv4 list made public IPv4 literals match as blocked through Node's internal mapped representation.
