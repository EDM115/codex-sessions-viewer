import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getCachedAsset } from "../../../server/cache/assetStore.ts";
import {
  getCachedSession,
  replaceCachedSession,
  updateCachedSessionRichContent,
} from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { prepareConversationForExport } from "../../../server/export/prepareConversation.ts";
import type { RichTextNode } from "../../../shared/types/richText.ts";
import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function descendants(nodes: readonly RichTextNode[]): RichTextNode[] {
  return nodes.flatMap((node) => [node, ...("children" in node ? descendants(node.children) : [])]);
}

describe("conversation export preparation", () => {
  it("parses rich message/reasoning bodies and gathers only referenced assets and link origins", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-prepare-export-"));
    temporaryDirectories.push(root);
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:fixture",
    });
    const assistant = conversation.turns[0]!.assistantMessages[0]!;
    assistant.sourceMarkdown =
      "Read [Nuxt](https://nuxt.com/docs).\n\n```ts title=reader.ts\nconst ready = true\n```";
    assistant.body = {
      type: "document",
      children: [{ type: "text", text: assistant.sourceMarkdown }],
    };
    const turn = conversation.turns[0]!;
    const steering = {
      ...turn.userMessage!,
      id: "message-steering",
      sourceMarkdown: "Please cover **Windows**.",
      body: {
        type: "document" as const,
        children: [{ type: "text" as const, text: "Please cover **Windows**." }],
      },
    };
    turn.steeringMessages = [steering];
    const reasoning = turn.activities.find((activity) => activity.kind === "reasoning");
    if (reasoning === undefined || reasoning.kind !== "reasoning") {
      throw new Error("Expected reasoning activity.");
    }
    reasoning.summary = "**Planning** the implementation";
    reasoning.body = {
      type: "document",
      children: [{ type: "text", text: reasoning.summary }],
    };
    const database = openCacheDatabase(":memory:");
    replaceCachedSession(database, {
      session: conversation,
      diagnostics: [],
      source: cachedSource(conversation),
    });

    try {
      const prepared = await prepareConversationForExport(database, conversation, {
        mediaRoot: join(root, "media-cache"),
        faviconRoot: join(root, "favicon-cache"),
        offline: true,
      });
      const nodes = descendants(
        prepared.conversation.turns[0]!.assistantMessages[0]!.body.children,
      );
      const steeringNodes = descendants(
        prepared.conversation.turns[0]!.steeringMessages![0]!.body.children,
      );
      const reasoningNodes = descendants(
        prepared.conversation.turns[0]!.activities.find(
          (activity) => activity.kind === "reasoning",
        )!.body!.children,
      );

      expect(nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "link", origin: "https://nuxt.com" }),
          expect.objectContaining({ type: "code", language: "ts", title: "reader.ts" }),
        ]),
      );
      expect(prepared.faviconOrigins).toEqual(new Set(["https://nuxt.com"]));
      expect(steeringNodes).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "element", tagName: "strong" })]),
      );
      expect(reasoningNodes).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "element", tagName: "strong" })]),
      );
      expect(prepared.assetIds).toEqual(new Set(["asset-raw-870-0", "asset-image-1"]));
      expect(getCachedAsset(database, "asset-raw-870-0")).toMatchObject({ status: "error" });
      expect(getCachedAsset(database, "asset-image-1")).toMatchObject({ status: "error" });
      expect(prepared.faviconResults).toEqual([
        expect.objectContaining({ origin: "https://nuxt.com", status: "fallback", pending: false }),
      ]);
      updateCachedSessionRichContent(database, prepared.conversation);
      const cached = getCachedSession(database, conversation.summary.id)!;
      expect(cached.turns[0]!.steeringMessages).toEqual([
        expect.objectContaining({
          id: "message-steering",
          sourceMarkdown: "Please cover **Windows**.",
        }),
      ]);
      const cachedNodes = descendants(cached.turns[0]!.assistantMessages[0]!.body.children);
      const reused = await prepareConversationForExport(database, cached, {
        mediaRoot: join(root, "media-cache"),
        faviconRoot: join(root, "favicon-cache"),
        offline: true,
      });

      expect(cachedNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "link", origin: "https://nuxt.com" }),
          expect.objectContaining({ type: "code", language: "ts", title: "reader.ts" }),
        ]),
      );
      expect(reused.faviconOrigins).toEqual(new Set(["https://nuxt.com"]));
      expect(reused.assetIds).toEqual(new Set(["asset-raw-870-0", "asset-image-1"]));
    } finally {
      database.close();
    }
  });

  it("retains IP-literal links while excluding them from favicon enrichment", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-prepare-export-"));
    temporaryDirectories.push(root);
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:fixture",
    });
    const assistant = conversation.turns[0]!.assistantMessages[0]!;
    assistant.sourceMarkdown = "Open the [local viewer](http://127.0.0.1:3000/session/example).";
    assistant.body = {
      type: "document",
      children: [{ type: "text", text: assistant.sourceMarkdown }],
    };
    const database = openCacheDatabase(":memory:");
    replaceCachedSession(database, {
      session: conversation,
      diagnostics: [],
      source: cachedSource(conversation),
    });

    try {
      const prepared = await prepareConversationForExport(database, conversation, {
        mediaRoot: join(root, "media-cache"),
        faviconRoot: join(root, "favicon-cache"),
        offline: true,
      });
      const nodes = descendants(
        prepared.conversation.turns[0]!.assistantMessages[0]!.body.children,
      );

      expect(nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "link",
            url: "http://127.0.0.1:3000/session/example",
            origin: "http://127.0.0.1:3000",
          }),
        ]),
      );
      expect(prepared.faviconOrigins).toEqual(new Set());
      expect(prepared.faviconResults).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("stores protocol data media and replaces its payload with bounded asset metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-prepare-export-"));
    temporaryDirectories.push(root);
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:fixture",
    });
    const media = conversation.turns
      .flatMap(({ activities }) => activities)
      .find((activity) => activity.kind === "media");
    if (media === undefined || media.kind !== "media") {
      throw new Error("Expected a media activity.");
    }
    const payload =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    media.reference = {
      kind: "data",
      mimeType: "image/png",
      encoding: "base64",
      payload,
      sourceHash: "e".repeat(64),
    };
    const database = openCacheDatabase(":memory:");
    replaceCachedSession(database, {
      session: conversation,
      diagnostics: [],
      source: cachedSource(conversation),
    });

    try {
      const prepared = await prepareConversationForExport(database, conversation, {
        mediaRoot: join(root, "media-cache"),
        faviconRoot: join(root, "favicon-cache"),
        offline: true,
      });
      const preparedMedia = prepared.conversation.turns
        .flatMap(({ activities }) => activities)
        .find((activity) => activity.kind === "media" && activity.assetId === media.assetId);

      expect(preparedMedia).toMatchObject({
        kind: "media",
        reference: {
          kind: "asset",
          mimeType: "image/png",
          byteSize: 68,
          sha256: expect.stringMatching(/^[a-f\d]{64}$/u),
        },
      });
      expect(getCachedAsset(database, media.assetId)).toMatchObject({
        status: "available",
        originalPath: `data:image/png;base64;sha256=${"e".repeat(64)}`,
      });
      expect(JSON.stringify(preparedMedia)).not.toContain(payload);
    } finally {
      database.close();
    }
  });
});
