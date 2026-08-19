# Plan 010: Apply and verify browser-containment headers in live and offline modes

> **Executor instructions**: Start with a header inventory and browser characterization. Choose the narrowest policy Nuxt hydration, Mermaid, Pagefind, media, fonts, and workers actually require; do not add unsafe-eval or remote origins. Update only plan 010's row after live/offline browser checks pass.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- nuxt.config.ts scripts/offline.ts server/core/securityHeaders.ts tests/unit/securityHeaders.test.ts tests/integration/live/contentBoundary.test.ts tests/e2e/release.spec.ts README.md  
> If the generated runtime now uses a different script/worker model, stop and re-inventory before choosing directives.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-restore-coverage-gate.md
- **Category**: security
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

The viewer renders local transcript-derived Markdown, sanitized HTML/SVG, Mermaid, code, media, and protocol evidence. Sanitization and loopback binding are primary controls, but neither Nuxt responses nor the offline server currently sets Content-Security-Policy or frame containment. A tested CSP limits the damage of a future rendering bug and prevents the local transcript surface from being framed, while preserving the explicit no-external-request boundary.

## Current state

```ts
// nuxt.config.ts:177-183
routeRules: {
  "/**": {
    headers: {
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  },
},
```

```ts
// scripts/offline.ts:133-142
response.writeHead(statusCode, {
  "Cache-Control": ...,
  "Content-Length": fileStats.size,
  "Content-Type": contentType,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});
```

Repository conventions: live is 127.0.0.1-only; generated output has no automatic external HTML/CSS resources; SVG is sanitized; existing E2E covers Mermaid/media/accessibility and release.spec.ts checks external-request behavior. Keep policies centralized so live and offline do not drift.

## Commands you will need

| Purpose           | Command                                                                                       | Expected on success                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Header units      | pnpm exec vitest run --project node tests/unit/securityHeaders.test.ts                        | Exit 0                                                                                              |
| Live boundary     | pnpm exec vitest run --project node tests/integration/live/contentBoundary.test.ts            | Exit 0                                                                                              |
| Build             | pnpm build                                                                                    | Exit 0; if sandbox-only readlink denial occurs, rerun exact command elevated                        |
| E2E               | pnpm test:e2e                                                                                 | Existing scenarios plus new CSP/header assertions pass; elevate only for documented readlink denial |
| Full source gates | pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration | Every command exits 0                                                                               |

## Scope

**In scope**: a small pure security-header module; Nuxt routeRules headers; offline server response headers; focused unit/live/E2E tests; a concise README note if hosting requirements need documentation.  
**Out of scope**: weakening rich-text/SVG sanitization; remote CDN allowances; unsafe-eval; authentication/accounts; non-loopback binding; a service worker; CSP reporting to a remote endpoint; changing Mermaid/Pagefind libraries; broad HTML templating changes without separate approval.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit authorization. If later authorized, use security(ui): add browser containment headers.

## Steps

### Step 1: Inventory runtime requirements and add failing header tests

Build a representative fixture and inspect live/offline HTML for executable inline scripts, inline styles, blob workers, data/blob media, local fonts, Pagefind workers, and network requests. Add tests asserting current responses lack CSP, then define required invariants: default-src self; base-uri none; object-src none; frame-ancestors none; form-action none; connect-src self; no unsafe-eval; no http/https remote source wildcard. Permit data/blob only for the media/font/worker directives proven necessary.  
**Verify**: header tests fail against df97571; existing release E2E remains green before policy changes.

### Step 2: Centralize the policy

Create server/core/securityHeaders.ts as a dependency-free module exporting an immutable header record and CSP string usable by nuxt.config.ts and scripts/offline.ts. Include Content-Security-Policy and preserve/refine Referrer-Policy, X-Content-Type-Options, and X-Robots-Tag consistently. Add X-Frame-Options: DENY as legacy defense if it does not conflict with project targets. Add a restrictive Permissions-Policy only for capabilities the viewer does not use.  
The target starting policy should be equivalent to: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; style-src 'self' plus only the inline allowance proven necessary; script-src 'self' plus only the inline allowance proven necessary; worker-src 'self' blob:. Do not copy this blindly—tests and inventory decide the minimum.  
**Verify**: unit test parses directives and asserts required/forbidden tokens; both Nuxt configuration and offline sendFile consume the shared headers rather than duplicate strings.

### Step 3: Prove live and offline behavior

Extend contentBoundary/release E2E to assert the CSP header on HTML, no CSP violation console messages, no blocked required resources, no external automatic request, no framing allowance, and successful hydration/navigation/search/Mermaid/media. Exercise both live Nuxt and the offline HTTP server; if current E2E cannot start offline.ts safely, add a bounded integration harness around an exported server factory rather than importing an unconditional CLI entrypoint.  
**Verify**: pnpm test:e2e and focused live/offline tests pass with zero unexpected request or CSP violation.

### Step 4: Tighten inline allowances where feasible

If Nuxt output supports hashes/nonces consistently in live and generated modes, replace unsafe-inline with hashes/nonces and test them. If static build output makes one inline allowance unavoidable, document the exact generated construct and retain the other containment directives; never add unsafe-eval. Do not build a fragile per-request HTML rewriter solely to remove one allowance.  
**Verify**: policy unit test rejects unsafe-eval and remote script/connect origins; build/E2E pass twice.

### Step 5: Run complete gates

**Verify**: pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration; pnpm build; pnpm test:e2e → all exit 0 under appropriate Windows permissions.

## Test plan

- Exact required CSP directives and forbidden unsafe-eval/remote origins.
- Nuxt live HTML response headers.
- Offline HTML, JS, CSS, JSON, font, media response headers without breaking immutable cache behavior.
- Hydration, navigation, Pagefind search fixture, Mermaid, SVG/image/audio viewer, local fonts, blob/data resources.
- Attempted iframe embedding is denied where testable.
- Browser console has no CSP violations; request log has no automatic external origins.

## Done criteria

- [ ] Live and offline HTML responses include one shared CSP policy.
- [ ] CSP includes default/base/object/frame/form/connect containment and no unsafe-eval or remote wildcard.
- [ ] Any unsafe-inline allowance is narrowly scoped, proven necessary, and documented in code/test.
- [ ] Existing sanitization and loopback controls remain unchanged.
- [ ] Live/offline E2E has no CSP violations or missing required features.
- [ ] All commands in Commands you will need exit 0.
- [ ] Only Scope files plus plan status are modified.

## STOP conditions

Stop if the policy requires unsafe-eval; if a remote origin must be allowed for normal offline operation; if tests cannot distinguish live and offline headers; if nonce/hash support requires an unbounded HTML rewriter or major Nuxt integration; if browser behavior breaks and the only proposed response is default-src *; or if the server would bind beyond loopback.

## Maintenance notes

New rendering libraries, workers, media schemes, or external-resource features must update the central policy and E2E together. Reviewers should inspect both response modes and browser console/network evidence; header presence alone is insufficient.
