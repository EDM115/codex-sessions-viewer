# Plan 002: Classify media references before any filesystem access

> **Executor instructions**: Follow every step and verification gate. Do not improvise a filesystem allowlist: if legitimate attachment provenance cannot be derived from current protocol evidence, stop and report the observed roots and proposed policy choices. Update only plan 002's row in plans/README.md when done.  
> **Drift check (run first)**: git diff --stat df97571..HEAD -- shared/types/conversation.ts server/normalization/normalizeSession.ts server/ingestion/discoverSources.ts server/content/extractMedia.ts server/export/prepareConversation.ts server/export/writeStaticPayloads.ts tests/unit/normalization/normalizeSession.test.ts tests/integration/source-boundary/sources.test.ts tests/unit/content/extractMedia.test.ts tests/unit/export/prepareConversation.test.ts tests/unit/export/staticPayloads.test.ts  
> Any semantic mismatch in these paths is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-restore-coverage-gate.md
- **Category**: bug, security, perf
- **Planned at**: commit df97571, 2026-08-19

## Why this matters

Protocol strings representing local paths, data URLs, remote URLs, and malformed values are currently collapsed into MediaActivity.sourcePath. The extractor then calls stat/readStableBytes on every nonempty value and accepts unknown bytes as .bin. This misclassifies real data:image values, bloats assets.json by preserving their full bodies as originalPath, and permits a malformed/imported transcript to make the viewer copy any user-readable regular file under 64 MiB. The fix must retain legitimate local attachments while keeping the viewer offline, Codex inputs read-only, and cache writes content-addressed.

## Current state

```ts
// server/normalization/normalizeSession.ts:262-294
const sources: Array<{ mediaType: MediaActivity["mediaType"]; path: string | null }> = [];
// local_images/images/local_audio/audio strings:
sources.push({ mediaType: "image", path: value });
// response_item input_image:
sources.push({ mediaType: "image", path: content["image_url"] });
```

```ts
// shared/types/conversation.ts:177-182
export interface MediaActivity extends ConversationActivityBase {
  kind: "media";
  assetId: string;
  mediaType: "image" | "audio" | "video" | "file";
  sourcePath: string | null;
}
```

```ts
// server/content/extractMedia.ts:147-180
const metadata = await stat(reference.path);
if (!metadata.isFile() || metadata.size > MAX_MEDIA_BYTES) throw new Error(...);
const read = await readStableBytes(reference.path, { endExclusive: metadata.size });
const media = await preparedMedia(read.bytes);
// preparedMedia falls back to extension "bin"; failures preserve reference.path as originalPath.
```

The existing output snapshot has 117 asset records in a roughly 7.65 MB manifest; 70 originalPath values start with data:, 54 exceed 8 KiB, and only 21 assets are available. Treat those numbers as reproduction evidence, not a golden fixture: the snapshot may be stale.  
Repository conventions: content bytes are copied through stableRead, SVG is sanitized before storage, content-addressed files are verified against SHA-256, and original input files are never modified. Follow server/content/extractMedia.ts writeContentAddressed and tests/unit/content/extractMedia.test.ts temporary-root cleanup.

## Commands you will need

| Purpose            | Command                                                                                                                    | Expected on success   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Normalization      | pnpm exec vitest run --project node tests/unit/normalization/normalizeSession.test.ts                                      | Exit 0                |
| Source boundary    | pnpm exec vitest run --project node tests/integration/source-boundary/sources.test.ts                                      | Exit 0                |
| Media storage      | pnpm exec vitest run --project node tests/unit/content/extractMedia.test.ts                                                | Exit 0                |
| Export preparation | pnpm exec vitest run --project node tests/unit/export/prepareConversation.test.ts tests/unit/export/staticPayloads.test.ts | Exit 0                |
| Full gates         | pnpm coverage; pnpm typecheck; pnpm lint; pnpm format:check; pnpm test; pnpm test:integration                              | Every command exits 0 |

## Scope

**In scope**:

- shared/types/conversation.ts — replace ambiguous sourcePath with a serializable discriminated media-reference contract, or add an equivalent adjacent type while preserving repository schemas.
- server/normalization/normalizeSession.ts — classify protocol strings without touching the filesystem.
- server/ingestion/discoverSources.ts — return only validated reference variants; rename ReferencedLocalMediaSource if it no longer represents every variant.
- server/content/extractMedia.ts — decode supported data URLs, enforce local-file provenance/type/size/link safety, bound errors/original references, and keep content-addressed writes.
- server/export/prepareConversation.ts and server/export/writeStaticPayloads.ts — consume the typed contract and publish bounded metadata.
- The five named test files in the drift check.  
  **Out of scope**: remote media fetching; broad network access; mutation of source attachments; changes to favicon retrieval; changing the 64 MiB ceiling without separate evidence; embedding raw data-URL bodies in manifests; a policy that assumes cwd is the only legitimate attachment root; full archive export.

## Git workflow

Do not create a branch, stage, commit, push, use a worktree, or open a PR without explicit operator authorization. If later authorized, use a conventional message such as fix(media): classify references before extraction.

## Steps

### Step 1: Characterize the accepted reference forms

Add normalization tests for: absolute local image/audio paths from user_message; response_item input_image containing an absolute local path; a base64 data:image URL; a percent-encoded data URL if the parser chooses to support it; https and file URLs; empty/malformed strings. Assert the normalized activity records a reference kind and bounded metadata, not merely a path string. Preserve asset IDs and message attachment IDs.  
**Verify**: pnpm exec vitest run --project node tests/unit/normalization/normalizeSession.test.ts → the new characterization tests fail on current code for the intended reasons, then pass after step 2.

### Step 2: Introduce a discriminated, serializable reference contract

Define a schema/type with explicit variants such as local-file { path }, data { mimeType, encoding, payload or decoded identifier }, remote { url }, and invalid { reason }. Keep decoded bytes out of ConversationSummary and JSON payloads; if normalization must retain a data payload temporarily, ensure static serialization replaces it with the content-addressed asset record before publication. Reject unbounded diagnostic/original strings by truncating to a small documented limit while preserving a hash or prefix useful for debugging.  
**Verify**: pnpm typecheck → exit 0; repository contract/Zod tests accept every intended variant and reject mixed/unknown variants.

### Step 3: Decode supported data media without filesystem calls

Parse only explicit data: syntax, require a supported image/audio MIME, decode with a pre-allocation size check, and send bytes through the same preparedMedia/SVG sanitization/content-addressed writer used by embedded media. Do not store the base64 body in originalPath or error text. Mark malformed/unsupported/oversized data values unavailable with bounded diagnostics.  
**Verify**: pnpm exec vitest run --project node tests/unit/content/extractMedia.test.ts → data PNG/SVG succeeds, malicious SVG is sanitized, malformed/oversized data fails without a filesystem stat and without an unbounded cache field.

### Step 4: Enforce local-file provenance and media type

Inventory the local roots represented by current test fixtures and protocol metadata before choosing the policy. At minimum, use lstat/realpath to reject symlinks, non-regular files, hard links when the existing cache boundary requires nlink=1, and files outside the explicit provenance roots. Reject unknown bytes instead of copying them as .bin; the detected MIME must be compatible with the declared mediaType. Keep stable-read change detection and the 64 MiB bound. If legitimate Codex attachments can originate from arbitrary user-selected paths and no trustworthy provenance marker exists, STOP and report rather than either breaking them or retaining arbitrary-file reads.  
**Verify**: pnpm exec vitest run --project node tests/unit/content/extractMedia.test.ts tests/integration/source-boundary/sources.test.ts → valid attachment succeeds unchanged; outside-root, symlink, hard-link, non-media, oversized, missing, and mid-read-changing cases produce bounded unavailable/error records and never copy bytes.

### Step 5: Publish a bounded asset manifest

Update preparation and static publication so remote/invalid references do not become local file reads and no originalPath/error field can contain an entire data URL. Preserve the public asset schema unless a version bump is necessary; if it is necessary, update the parser, verifier, and fixtures atomically. Add an assertion that a representative data image produces an assets.json whose size is proportional to metadata plus decoded asset bytes stored separately, not base64 text.  
**Verify**: pnpm exec vitest run --project node tests/unit/export/prepareConversation.test.ts tests/unit/export/staticPayloads.test.ts tests/unit/export/verifyOutput.test.ts → all pass and the manifest contains no data: body.

### Step 6: Run complete gates

Run coverage first, then the focused/full source suites. Do not run the real archive-wide export.  
**Verify**: pnpm coverage; pnpm format:check; pnpm typecheck; pnpm lint; pnpm test; pnpm test:integration; pnpm test:performance → all exit 0.

## Test plan

- Normalization: all four reference classes, attachment ID stability, empty/unknown protocol values.
- Data media: base64 PNG, sanitized SVG, malformed encoding, unsupported MIME, declared/actual MIME mismatch, decoded size overflow.
- Local files: legitimate path, missing path, directory, symlink, hard link, outside provenance, unknown bytes, oversized media, file modified during stable read.
- Export: no data body in SQLite error/originalPath or assets.json; content-addressed URL integrity remains valid; unavailable records remain visible but bounded.
- Model tests after tests/unit/content/extractMedia.test.ts and tests/unit/export/verifyOutput.test.ts.

## Done criteria

- [ ] No protocol value reaches stat/readStableBytes without first being classified as an approved local-file reference.
- [ ] Supported data media is decoded, sanitized/sniffed, and stored content-addressed without retaining its body in manifest/cache metadata.
- [ ] Unknown/non-media local files are not copied as .bin.
- [ ] Local attachment provenance is explicit and tested, or the plan is BLOCKED with observed legitimate roots documented.
- [ ] Every error/original-reference field has an asserted size bound.
- [ ] Focused tests and all full gates in Commands you will need exit 0.
- [ ] git status --short contains no files outside Scope plus the plan status row.

## STOP conditions

Stop if current protocol evidence cannot distinguish legitimate arbitrary user attachments from attacker-selected filesystem paths; if closing the boundary requires remote downloads; if the public repository contract must change without a versioned migration; if source attachments would be modified; or if the change makes a missing optional attachment prevent conversation loading.

## Maintenance notes

Future protocol fields carrying media must enter through the same classifier. Reviewers should scrutinize URL decoding, pre-allocation size checks, realpath/link behavior on Windows, MIME sniffing, bounded diagnostics, and static/live parity. Plan 006 may assume the resulting asset manifest is bounded and immutable per repository instance.
