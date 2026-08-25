import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverReferencedMedia,
  discoverSources,
} from "../../../server/ingestion/discoverSources.ts";
import {
  partitionJsonlTail,
  stableRead,
  type StableReadChunk,
} from "../../../server/ingestion/stableRead.ts";
import type { ConversationActivity } from "../../../shared/types/conversation.ts";

const temporaryDirectories: string[] = [];

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-source-boundary-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, "sessions", "2026", "08", "13"), { recursive: true }),
    mkdir(join(root, "archived_sessions", "nested"), { recursive: true }),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex source discovery", () => {
  it("discovers only allowlisted rollout and metadata sources", async () => {
    const codexHome = await createCodexHome();
    const active = join(codexHome, "sessions", "2026", "08", "13", "active.jsonl");
    const archived = join(codexHome, "archived_sessions", "nested", "archived.jsonl");
    await Promise.all([
      writeFile(active, "{}\n", "utf8"),
      writeFile(archived, "{}\n", "utf8"),
      writeFile(join(codexHome, "session_index.jsonl"), "{}\n", "utf8"),
      writeFile(join(codexHome, ".codex-global-state.json"), "{}", "utf8"),
      writeFile(join(codexHome, "state_5.sqlite"), "sqlite", "utf8"),
      writeFile(join(codexHome, "state_5.sqlite-wal"), "wal", "utf8"),
      writeFile(join(codexHome, "auth.json"), '{"token":"secret"}', "utf8"),
      writeFile(join(codexHome, "secret-rollout.jsonl"), "{}\n", "utf8"),
    ]);

    const result = await discoverSources(codexHome);

    expect(result.rollouts).toEqual([
      { path: archived, scope: "archived" },
      { path: active, scope: "active" },
    ]);
    expect(result.metadata).toEqual({
      globalState: join(codexHome, ".codex-global-state.json"),
      sessionIndex: join(codexHome, "session_index.jsonl"),
      stateDatabase: join(codexHome, "state_5.sqlite"),
      stateWal: join(codexHome, "state_5.sqlite-wal"),
    });
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("auth.json");
    expect(JSON.stringify(result)).not.toContain("secret-rollout.jsonl");
  });

  it("discovers typed media lazily only from normalized media activities", () => {
    const activities = [
      {
        id: "media-1",
        turnId: "turn-1",
        createdAt: null,
        rawEventIds: ["event-1"],
        kind: "media",
        assetId: "asset-1",
        mediaType: "image",
        reference: {
          kind: "local-file",
          path: "C:\\Users\\viewer\\image.png",
          provenance: "user-message",
        },
      },
      {
        id: "status-1",
        turnId: "turn-1",
        createdAt: null,
        rawEventIds: ["event-2"],
        kind: "status",
        status: "succeeded",
        message: "C:\\Users\\viewer\\unreferenced-secret.png",
      },
      {
        id: "media-2",
        turnId: "turn-1",
        createdAt: null,
        rawEventIds: ["event-3"],
        kind: "media",
        assetId: "asset-2",
        mediaType: "audio",
        reference: {
          kind: "invalid",
          reason: "missing",
          preview: "",
          sourceHash: null,
        },
      },
      {
        id: "media-3",
        turnId: "turn-1",
        createdAt: null,
        rawEventIds: ["event-4"],
        kind: "media",
        assetId: "asset-3",
        mediaType: "image",
        reference: {
          kind: "data",
          mimeType: "image/png",
          encoding: "base64",
          payload: "AA==",
          sourceHash: "a".repeat(64),
        },
      },
      {
        id: "media-4",
        turnId: "turn-1",
        createdAt: null,
        rawEventIds: ["event-5"],
        kind: "media",
        assetId: "asset-4",
        mediaType: "image",
        reference: { kind: "remote", url: "https://example.test/image.png" },
      },
      {
        id: "media-5",
        turnId: "turn-1",
        createdAt: null,
        rawEventIds: ["event-6"],
        kind: "media",
        assetId: "asset-5",
        mediaType: "image",
        reference: {
          kind: "asset",
          mimeType: "image/png",
          byteSize: 1,
          sha256: "a".repeat(64),
        },
      },
    ] satisfies ConversationActivity[];

    const references = discoverReferencedMedia(activities);

    expect(references).toEqual([
      {
        assetId: "asset-1",
        mediaType: "image",
        reference: {
          kind: "local-file",
          path: "C:\\Users\\viewer\\image.png",
          provenance: "user-message",
        },
      },
      {
        assetId: "asset-2",
        mediaType: "audio",
        reference: {
          kind: "invalid",
          reason: "missing",
          preview: "",
          sourceHash: null,
        },
      },
      {
        assetId: "asset-3",
        mediaType: "image",
        reference: {
          kind: "data",
          mimeType: "image/png",
          encoding: "base64",
          payload: "AA==",
          sourceHash: "a".repeat(64),
        },
      },
      {
        assetId: "asset-4",
        mediaType: "image",
        reference: { kind: "remote", url: "https://example.test/image.png" },
      },
    ]);
    expect(JSON.stringify(references)).not.toContain("unreferenced-secret.png");
    expect(JSON.stringify(references)).not.toContain('"kind":"asset"');
  });
});

describe("stable source reads", () => {
  it("streams the selected range and preserves an incomplete JSONL tail", async () => {
    const codexHome = await createCodexHome();
    const source = join(codexHome, "sessions", "2026", "08", "13", "range.jsonl");
    await writeFile(source, '{"id":1}\n{"id":2', "utf8");
    const chunks: Buffer[] = [];

    const result = await stableRead(source, {
      start: 0,
      chunkSize: 5,
      onChunk(chunk: StableReadChunk) {
        chunks.push(Buffer.from(chunk.bytes));
      },
    });
    const partitioned = partitionJsonlTail(Buffer.concat(chunks));

    expect(result.status).toBe("stable");
    expect(result.bytesRead).toBe(16);
    expect(partitioned.complete.toString("utf8")).toBe('{"id":1}\n');
    expect(partitioned.pending.toString("utf8")).toBe('{"id":2');
  });

  it("discards a pass when the source changes while it is being read", async () => {
    const codexHome = await createCodexHome();
    const source = join(codexHome, "sessions", "2026", "08", "13", "growing.jsonl");
    await writeFile(source, "first\nsecond\n", "utf8");
    let appended = false;

    const result = await stableRead(source, {
      chunkSize: 3,
      async onChunk() {
        if (!appended) {
          appended = true;
          await appendFile(source, "third\n", "utf8");
        }
      },
    });

    expect(result).toMatchObject({
      status: "changed",
      retry: true,
      bytesRead: 13,
    });
  });

  it("requests a full reparse when a persisted offset is beyond the current file", async () => {
    const codexHome = await createCodexHome();
    const source = join(codexHome, "sessions", "2026", "08", "13", "truncated.jsonl");
    await writeFile(source, "short\n", "utf8");

    const result = await stableRead(source, { start: 20 });

    expect(result).toMatchObject({
      status: "full-reparse",
      reason: "truncated",
      bytesRead: 0,
    });
  });

  it("requests a full reparse when a persisted prefix no longer matches", async () => {
    const codexHome = await createCodexHome();
    const source = join(codexHome, "sessions", "2026", "08", "13", "replaced-prefix.jsonl");
    await writeFile(source, "new-prefix\n", "utf8");

    const result = await stableRead(source, {
      expectedPrefix: { offset: 0, bytes: Buffer.from("old-prefix") },
    });

    expect(result).toMatchObject({
      status: "full-reparse",
      reason: "prefix-mismatch",
      bytesRead: 0,
    });
  });
});
