import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";

import { upsertCachedAsset } from "../../../server/cache/assetStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { writeConversationExport } from "../../../server/export/writeConversationExport.ts";
import {
  publishCachedContent,
  reconcileStaticSessionArtifacts,
  writeStaticPayloads,
} from "../../../server/export/writeStaticPayloads.ts";
import {
  classifyCatalogThread,
  classifyNormalizedSession,
  type CatalogThreadMetadata,
} from "../../../server/metadata/threadClassification.ts";
import type { NormalizedSession } from "../../../server/normalization/normalizeSession.ts";
import type { JsonObject } from "../../../shared/types/conversation.ts";
import { staticLibraryPayloadSchema } from "../../../shared/types/staticPayloads.ts";
import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

const temporaryDirectories: string[] = [];
const sessionIndexSchema = z.object({
  version: z.number(),
  sessions: z.array(z.object({ id: z.string(), parentThreadId: z.string().nullable() })),
});
const navigatorSchema = z.object({
  version: z.literal(2),
  items: z.array(
    z.object({
      turnId: z.string(),
      promptPreview: z.string(),
      proseLengthBucket: z.number(),
    }),
  ),
  chunkSize: z.number(),
  chunkCount: z.number(),
  turnChunks: z.record(z.string(), z.number()),
  inspectorChunks: z.record(z.string(), z.number()),
});
const turnChunkSchema = z.object({
  turns: z.array(z.object({ id: z.string() })),
  previousCursor: z.string().nullable(),
  nextCursor: z.string().nullable(),
});
const inspectorChunkSchema = z.object({
  version: z.literal(2),
  records: z.array(
    z.object({
      target: z.object({ type: z.string(), id: z.string() }),
      eventIds: z.array(z.string()),
    }),
  ),
  rawRecords: z.record(z.string(), z.object({ id: z.string() }).passthrough()),
});
const assetManifestSchema = z.object({
  assets: z.array(
    z.object({ id: z.string(), url: z.string().nullable(), originalPath: z.string().nullable() }),
  ),
});
const faviconManifestSchema = z.object({
  favicons: z.array(z.object({ origin: z.string(), url: z.string() })),
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-export-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("conversation Markdown files", () => {
  it("preserves child project and agent identity while tree counts belong only to roots", async () => {
    const generatedRoot = await temporaryRoot();
    const root = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixtures/root.jsonl",
      scope: "active",
      revision: "root-rev",
    });
    root.summary.parentThreadId = null;
    root.classification = classifyCatalogThread({ threadSource: "user" });
    const child = structuredClone(root);
    delete child.classification;
    child.summary = {
      ...child.summary,
      id: "cross-project-child",
      parentThreadId: root.summary.id,
      scope: "archived",
      cwd: "D:/other-repository",
      gitOriginUrl: null,
      sourcePath: "D:/fixtures/child.jsonl",
    };
    child.turns = [];
    child.rawEvents = [
      {
        id: "child-meta",
        turnId: null,
        type: "session_meta",
        timestamp: null,
        payload: {
          id: child.summary.id,
          parent_thread_id: root.summary.id,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: root.summary.id,
                agent_path: "/root/child",
                agent_nickname: "Child",
              },
            },
          },
        },
      },
    ];
    await writeStaticPayloads([root, child], { generatedRoot, writeSessions: false });
    const library = staticLibraryPayloadSchema.parse(
      JSON.parse(await readFile(join(generatedRoot, "payloads", "projects.json"), "utf8")),
    );
    expect(library.entries[child.summary.id]).toMatchObject({
      kind: "subagent",
      parentThreadId: root.summary.id,
      agentPath: "/root/child",
      agentNickname: "Child",
      agentDepth: 1,
    });
    expect(library.entries[child.summary.id]?.projectId).not.toBe(
      library.entries[root.summary.id]?.projectId,
    );
    expect(library.entries[root.summary.id]?.childCount).toBe(1);
    expect(
      library.projects.reduce(
        (sum, project) => sum + project.activeCount + project.archivedCount,
        0,
      ),
    ).toBe(1);
  });

  it("writes private and downloadable Markdown atomically and reuses unchanged bytes", async () => {
    const root = await temporaryRoot();
    const generatedRoot = join(root, ".generated");
    const publicRoot = join(root, "public");
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "sessions", "modern.jsonl"),
      scope: "active",
      revision: "sha256:fixture",
    });
    const first = await writeConversationExport(conversation, { generatedRoot, publicRoot });
    const second = await writeConversationExport(conversation, { generatedRoot, publicRoot });
    const privateMarkdown = join(
      generatedRoot,
      "markdown",
      "active",
      `${conversation.summary.id}.md`,
    );

    expect(first).toMatchObject({ generated: "written", published: "written" });
    expect(second).toMatchObject({ generated: "reused", published: "reused" });
    expect(await readFile(privateMarkdown, "utf8")).toContain("# Build the parser");
    expect(
      await readFile(
        join(publicRoot, "downloads", "active", `${conversation.summary.id}.md`),
        "utf8",
      ),
    ).toBe(await readFile(privateMarkdown, "utf8"));
  });

  it("replaces an existing viewer-owned export when its content changes", async () => {
    const root = await temporaryRoot();
    const generatedRoot = join(root, ".generated");
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "sessions", "modern.jsonl"),
      scope: "active",
      revision: "sha256:first",
    });

    await writeConversationExport(conversation, { generatedRoot });
    conversation.summary.title = "A changed export title";
    conversation.summary.revision = "sha256:second";
    const result = await writeConversationExport(conversation, { generatedRoot });
    const markdown = await readFile(
      join(generatedRoot, "markdown", "active", `${conversation.summary.id}.md`),
      "utf8",
    );

    expect(result.generated).toBe("written");
    expect(markdown).toContain('title: "A changed export title"');
    expect(markdown).toContain('revision: "sha256:second"');
  });

  it("rejects a session identity that could escape the viewer-owned output root", async () => {
    const root = await temporaryRoot();
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:fixture",
    });
    conversation.summary.id = "../outside";

    await expect(
      writeConversationExport(conversation, { generatedRoot: join(root, ".generated") }),
    ).rejects.toThrow("safe output component");
  });
});

describe("static repository payloads", () => {
  it("exports cross-source ownership as roots and preserves explicit spawn coexistence", async () => {
    const generatedRoot = await temporaryRoot();
    const template = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixtures/ownership.jsonl",
      scope: "active",
      revision: "cross-source-ownership",
    });
    const cases: Array<{
      id: string;
      raw: JsonObject;
      native: CatalogThreadMetadata;
      edge?: boolean;
    }> = [
      { id: "raw-attached", raw: { attached_parent_thread_id: "owner" }, native: {} },
      { id: "native-attached", raw: {}, native: { attachedParentThreadId: "owner" } },
      { id: "raw-fork", raw: { forked_from_id: "owner" }, native: {} },
      { id: "native-fork", raw: {}, native: { forkedFromId: "owner" } },
      {
        id: "raw-spawn",
        raw: { source: { subagent: { thread_spawn: { parent_thread_id: "owner" } } } },
        native: { attachedParentThreadId: "owner" },
      },
      {
        id: "native-spawn",
        raw: { forked_from_id: "owner" },
        native: { source: { subAgent: { threadSpawn: { parentThreadId: "owner" } } } },
      },
      { id: "edge-spawn", raw: { attached_parent_thread_id: "owner" }, native: {}, edge: true },
    ];
    const sessions = cases.map((entry) => {
      const session: NormalizedSession = {
        summary: { ...template.summary, id: entry.id, parentThreadId: "owner", childThreadIds: [] },
        turns: [],
        rawEvents: [
          {
            id: `${entry.id}-meta`,
            type: "session_meta",
            timestamp: null,
            turnId: null,
            payload: {
              type: "session_meta",
              payload: {
                id: entry.id,
                source: "cli",
                thread_source: "user",
                parent_thread_id: "owner",
                ...entry.raw,
              },
            },
          },
        ],
      };
      session.classification = classifyNormalizedSession(
        session,
        { source: "cli", parentThreadId: "owner", ...entry.native },
        entry.edge ? { spawnParentThreadId: "owner" } : {},
      );
      return session;
    });
    sessions.push({
      summary: { ...template.summary, id: "owner", parentThreadId: null, childThreadIds: [] },
      turns: [],
      rawEvents: [],
      classification: classifyCatalogThread({ threadSource: "user" }),
    });
    await writeStaticPayloads(sessions, { generatedRoot });
    const library = staticLibraryPayloadSchema.parse(
      JSON.parse(await readFile(join(generatedRoot, "payloads/projects.json"), "utf8")),
    );
    expect(
      Object.entries(library.entries)
        .filter(([, entry]) => entry.kind === "root")
        .map(([id]) => id)
        .toSorted(),
    ).toEqual(["native-attached", "native-fork", "owner", "raw-attached", "raw-fork"]);
    expect(library.projects.reduce((sum, project) => sum + project.activeCount, 0)).toBe(5);
    expect(library.entries["owner"]?.childCount).toBe(3);
    expect(
      Object.entries(library.entries)
        .filter(([, entry]) => entry.kind === "subagent")
        .map(([id]) => id)
        .toSorted(),
    ).toEqual(["edge-spawn", "native-spawn", "raw-spawn"]);
  });
  it("applies structural export visibility and retains orphan topology without counting it as a root", async () => {
    const generatedRoot = await temporaryRoot();
    const template = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixtures/template.jsonl",
      scope: "active",
      revision: "classification-export",
    });
    const metadata: Array<JsonObject & { id: string }> = [
      { id: "user", thread_source: "user", source: "cli" },
      { id: "helper", thread_source: "guardian_review" },
      { id: "scan", threadSource: "security_scan" },
      { id: "unknown", thread_source: "custom" },
      {
        id: "unknown-spawn",
        thread_source: "custom",
        source: { subagent: { thread_spawn: { parent_thread_id: "user" } } },
      },
      { id: "malformed-role", thread_source: 12 },
      { id: "malformed-ephemeral", ephemeral: "true" },
      { id: "malformed-source", source: 12 },
      { id: "incomplete-spawn", source: { subagent: { thread_spawn: {} } } },
      { id: "child", source: { subAgent: { threadSpawn: { parentThreadId: "user" } } } },
      { id: "orphan", source: { subagent: { thread_spawn: { parent_thread_id: "missing" } } } },
      {
        id: "attached",
        thread_source: "user",
        parent_thread_id: "user",
        attached_parent_thread_id: "user",
      },
    ];
    const sessions: NormalizedSession[] = metadata.map((meta) => ({
      summary: {
        ...template.summary,
        id: meta.id,
        models: ["codex-auto-review"],
        title: "Untitled",
        parentThreadId: null,
        childThreadIds: [],
      },
      turns: [],
      rawEvents: [
        {
          id: `${meta.id}-meta`,
          type: "session_meta",
          timestamp: null,
          turnId: null,
          payload: { type: "session_meta", payload: meta },
        },
      ],
    }));
    sessions[0]!.approvalEvidence = {
      sessionId: "user",
      matched: [],
      unattached: [
        {
          reason: "missing-tool-or-turn",
          review: {
            reviewedAction: { cmd: "same" },
            outcome: null,
            riskLevel: "unknown",
            userAuthorization: null,
            rationale: "Pending review",
            reviewedAt: null,
            parentThreadId: "user",
            guardianSessionId: "helper",
            rawEventIds: ["raw-v2-qualified-review"],
          },
        },
      ],
    };
    await writeStaticPayloads(sessions, { generatedRoot });
    const library = staticLibraryPayloadSchema.parse(
      JSON.parse(await readFile(join(generatedRoot, "payloads/projects.json"), "utf8")),
    );
    expect(Object.keys(library.entries).toSorted()).toEqual([
      "attached",
      "child",
      "orphan",
      "user",
    ]);
    expect(library.projects.reduce((sum, project) => sum + project.activeCount, 0)).toBe(2);
    expect(library.entries["orphan"]).toMatchObject({
      kind: "subagent",
      parentThreadId: "missing",
    });
    expect(library.entries["user"]?.childCount).toBe(1);
    expect(
      JSON.parse(
        await readFile(join(generatedRoot, "payloads/sessions/user/approvals.json"), "utf8"),
      ),
    ).toEqual(sessions[0]!.approvalEvidence);
  });
  it("writes one-turn chunks, navigator records, inspectors, and a small session index", async () => {
    const root = await temporaryRoot();
    const generatedRoot = join(root, ".generated");
    const publicRoot = join(root, "public");
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "sessions", "modern.jsonl"),
      scope: "active",
      revision: "sha256:fixture",
    });
    const result = await writeStaticPayloads([conversation], {
      generatedRoot,
      publicRoot,
      chunkSize: 1,
    });
    const sessionRoot = join(generatedRoot, "payloads", "sessions", conversation.summary.id);
    const index = sessionIndexSchema.parse(
      JSON.parse(await readFile(join(generatedRoot, "payloads", "sessions", "index.json"), "utf8")),
    );
    const navigator = navigatorSchema.parse(
      JSON.parse(await readFile(join(sessionRoot, "navigator.json"), "utf8")),
    );
    const projects = staticLibraryPayloadSchema.parse(
      JSON.parse(await readFile(join(generatedRoot, "payloads", "projects.json"), "utf8")),
    );
    const firstChunk = turnChunkSchema.parse(
      JSON.parse(await readFile(join(sessionRoot, "turn-0.json"), "utf8")),
    );
    const inspectorText = await readFile(join(sessionRoot, "inspector-0.json"), "utf8");
    const inspector = inspectorChunkSchema.parse(JSON.parse(inspectorText));

    expect(result).toMatchObject({ sessionCount: 1, turnChunkCount: 2, published: true });
    expect(index).toEqual({
      version: 1,
      sessions: [
        expect.objectContaining({
          id: conversation.summary.id,
          parentThreadId: conversation.summary.parentThreadId,
        }),
      ],
    });
    expect(projects.projects).toEqual([
      expect.objectContaining({ activeCount: 0, archivedCount: 0, source: "git" }),
    ]);
    expect(projects.entries[conversation.summary.id]).toMatchObject({
      kind: "subagent",
      parentThreadId: conversation.summary.parentThreadId,
      childCount: 0,
    });
    expect(navigator).toMatchObject({
      version: 2,
      chunkSize: 1,
      chunkCount: 2,
      turnChunks: { "turn-1": 0, "turn-2": 1 },
      items: [
        expect.objectContaining({ turnId: "turn-1", promptPreview: "Build the parser" }),
        expect.objectContaining({ turnId: "turn-2" }),
      ],
    });
    expect(
      navigator.items.every(({ proseLengthBucket }) => [1, 2, 3, 4].includes(proseLengthBucket)),
    ).toBe(true);
    expect(navigator.inspectorChunks).toMatchObject({
      "turn:turn-1": 0,
      [`message:${conversation.turns[0]!.userMessage!.id}`]: 0,
      [`activity:${conversation.turns[0]!.activities.find((activity) => activity.kind === "reasoning")!.id}`]: 0,
      "turn:turn-2": 1,
    });
    expect(firstChunk).toMatchObject({
      turns: [{ id: "turn-1" }],
      previousCursor: null,
      nextCursor: "1",
    });
    expect(inspector.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: { type: "turn", id: "turn-1" } }),
        expect.objectContaining({
          target: { type: "message", id: conversation.turns[0]!.userMessage!.id },
        }),
        expect.objectContaining({
          target: {
            type: "activity",
            id: conversation.turns[0]!.activities.find((activity) => activity.kind === "reasoning")!
              .id,
          },
        }),
      ]),
    );
    expect(Object.keys(inspector.rawRecords).length).toBeGreaterThan(0);
    expect(inspectorText.match(/"rawRecords"/gu)).toHaveLength(1);
    const firstTurn = conversation.turns[0]!;
    for (const message of [firstTurn.userMessage, ...firstTurn.assistantMessages].filter(
      (candidate) => candidate !== null,
    )) {
      const record = inspector.records.find(
        ({ target }) => target.type === "message" && target.id === message.id,
      );
      expect(record?.eventIds).toEqual(message.rawEventIds);
      expect(record?.eventIds.map((id) => inspector.rawRecords[id]?.id)).toEqual(
        message.rawEventIds,
      );
    }
    expect(await readFile(join(publicRoot, "payloads", "sessions", "index.json"), "utf8")).toBe(
      await readFile(join(generatedRoot, "payloads", "sessions", "index.json"), "utf8"),
    );
    expect(await readFile(join(publicRoot, "payloads", "projects.json"), "utf8")).toBe(
      await readFile(join(generatedRoot, "payloads", "projects.json"), "utf8"),
    );
  });

  it("starts a new static chunk before the configured byte budget aggregates large turns", async () => {
    const root = await temporaryRoot();
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "sessions", "modern.jsonl"),
      scope: "active",
      revision: "sha256:byte-bounded",
    });
    conversation.summary.parentThreadId = null;

    const result = await writeStaticPayloads([conversation], {
      generatedRoot: root,
      chunkSize: 20,
      maxChunkBytes: 1,
    });
    const navigator = JSON.parse(
      await readFile(
        join(root, "payloads", "sessions", conversation.summary.id, "navigator.json"),
        "utf8",
      ),
    ) as {
      chunkCount: number;
      turnChunks: Record<string, number>;
    };

    expect(result.turnChunkCount).toBe(conversation.turns.length);
    expect(navigator.chunkCount).toBe(conversation.turns.length);
    expect(navigator.turnChunks).toEqual({ "turn-1": 0, "turn-2": 1 });
  });

  it("removes obsolete chunk files only after a smaller replacement payload succeeds", async () => {
    const root = await temporaryRoot();
    const generatedRoot = join(root, ".generated");
    const publicRoot = join(root, "public");
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "sessions", "modern.jsonl"),
      scope: "active",
      revision: "sha256:first",
    });

    await writeStaticPayloads([conversation], { generatedRoot, publicRoot, chunkSize: 1 });
    conversation.turns = conversation.turns.slice(0, 1);
    conversation.summary.revision = "sha256:second";
    await writeStaticPayloads([conversation], { generatedRoot, publicRoot, chunkSize: 1 });

    const filesByRoot = await Promise.all(
      [generatedRoot, publicRoot].map((rootPath) =>
        readdir(join(rootPath, "payloads", "sessions", conversation.summary.id)),
      ),
    );
    expect(filesByRoot).toEqual([
      ["inspector-0.json", "navigator.json", "summary.json", "turn-0.json"],
      ["inspector-0.json", "navigator.json", "summary.json", "turn-0.json"],
    ]);
  });

  it("removes only stale session artifacts after an explicitly complete reconciliation", async () => {
    const root = await temporaryRoot();
    const generatedRoot = join(root, ".generated");
    const staleId = "22222222-2222-4222-8222-222222222222";
    await mkdir(join(generatedRoot, "payloads", "sessions", staleId), { recursive: true });
    await mkdir(join(generatedRoot, "markdown", "archived"), { recursive: true });
    await writeFile(join(generatedRoot, "payloads", "sessions", staleId, "summary.json"), "{}");
    await writeFile(join(generatedRoot, "markdown", "archived", `${staleId}.md`), "stale");

    expect(
      await reconcileStaticSessionArtifacts(generatedRoot, new Map(), {
        completeReconciliation: false,
      }),
    ).toEqual([]);
    expect(await readdir(join(generatedRoot, "payloads", "sessions"))).toContain(staleId);

    expect(
      await reconcileStaticSessionArtifacts(generatedRoot, new Map(), {
        completeReconciliation: true,
      }),
    ).toEqual([
      join(generatedRoot, "markdown", "archived", `${staleId}.md`),
      join(generatedRoot, "payloads", "sessions", staleId),
    ]);
    expect(await readdir(join(generatedRoot, "payloads", "sessions"))).not.toContain(staleId);
  });

  it("publishes only integrity-checked referenced assets and favicon origins", async () => {
    const root = await temporaryRoot();
    const generatedRoot = join(root, ".generated");
    const publicRoot = join(root, "public");
    const cacheRoot = join(root, "cache");
    const assetBytes = Buffer.from("local attachment bytes");
    const legacyDataBody = "A".repeat(10_000);
    const legacyDataUrl = `data:image/png;base64,${legacyDataBody}`;
    const faviconBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const assetHash = createHash("sha256").update(assetBytes).digest("hex");
    const faviconHash = createHash("sha256").update(faviconBytes).digest("hex");
    const assetPath = join(cacheRoot, `${assetHash}.bin`);
    const faviconPath = join(cacheRoot, `${faviconHash}.png`);
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(assetPath, assetBytes);
    await writeFile(faviconPath, faviconBytes);
    const database = openCacheDatabase(":memory:");

    try {
      upsertCachedAsset(database, {
        id: "asset-used",
        sessionId: null,
        url: null,
        mimeType: "application/octet-stream",
        byteSize: assetBytes.byteLength,
        sha256: assetHash,
        width: null,
        height: null,
        status: "available",
        originalPath: legacyDataUrl,
        cachePath: assetPath,
        error: null,
      });
      upsertCachedAsset(database, {
        id: "asset-unreferenced",
        sessionId: null,
        url: null,
        mimeType: "application/octet-stream",
        byteSize: assetBytes.byteLength,
        sha256: assetHash,
        width: null,
        height: null,
        status: "available",
        originalPath: "C:\\Codex\\unreferenced.bin",
        cachePath: assetPath,
        error: null,
      });
      database
        .prepare(`
        INSERT INTO favicons (origin, url, mime_type, byte_size, sha256, cache_path, status, fetched_at, error)
        VALUES (?, ?, ?, ?, ?, ?, 'available', ?, NULL)
      `)
        .run(
          "https://example.com",
          "https://example.com/favicon.ico",
          "image/png",
          faviconBytes.byteLength,
          faviconHash,
          faviconPath,
          "2026-08-13T10:00:00.000Z",
        );

      const result = await publishCachedContent(database, {
        generatedRoot,
        publicRoot,
        assetIds: new Set(["asset-used"]),
        faviconOrigins: new Set(["https://example.com"]),
      });
      const assetManifest = assetManifestSchema.parse(
        JSON.parse(await readFile(join(generatedRoot, "payloads", "assets.json"), "utf8")),
      );
      const assetManifestText = await readFile(
        join(generatedRoot, "payloads", "assets.json"),
        "utf8",
      );
      const faviconManifest = faviconManifestSchema.parse(
        JSON.parse(await readFile(join(generatedRoot, "payloads", "favicons.json"), "utf8")),
      );

      expect(result).toEqual({ assetCount: 1, faviconCount: 1, failedCount: 0 });
      expect(assetManifest.assets).toEqual([
        expect.objectContaining({
          id: "asset-used",
          url: `/assets/${assetHash}.bin`,
          originalPath: `data:image/png;base64;sha256=${createHash("sha256").update(legacyDataUrl).digest("hex")}`,
        }),
      ]);
      expect(assetManifestText).not.toContain(legacyDataBody);
      expect(assetManifestText.length).toBeLessThan(2_048);
      expect(faviconManifest.favicons).toEqual([
        expect.objectContaining({
          origin: "https://example.com",
          url: `/favicons/${faviconHash}.png`,
        }),
      ]);
      expect(await readFile(join(publicRoot, "assets", `${assetHash}.bin`))).toEqual(assetBytes);
      expect(await readFile(join(publicRoot, "favicons", `${faviconHash}.png`))).toEqual(
        faviconBytes,
      );
      expect(await readdir(join(generatedRoot, "assets"))).toEqual([`${assetHash}.bin`]);
    } finally {
      database.close();
    }
  });
});
