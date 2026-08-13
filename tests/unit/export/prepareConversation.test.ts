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
          expect.objectContaining({ type: "link", origin: "https://nuxt.com" }),
          expect.objectContaining({ type: "code", language: "ts", title: "reader.ts" }),
        ]),
      );
      expect(prepared.faviconOrigins).toEqual(new Set(["https://nuxt.com"]));
      expect(prepared.assetIds).toEqual(new Set(["asset-raw-870-0", "asset-image-1"]));
      expect(getCachedAsset(database, "asset-raw-870-0")).toMatchObject({ status: "missing" });
      expect(getCachedAsset(database, "asset-image-1")).toMatchObject({ status: "missing" });
      expect(prepared.faviconResults).toEqual([
        expect.objectContaining({ origin: "https://nuxt.com", status: "fallback", pending: false }),
      ]);
      updateCachedSessionRichContent(database, prepared.conversation);
      const cached = getCachedSession(database, conversation.summary.id)!;
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
});
