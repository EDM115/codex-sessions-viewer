import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import { prepareHistoryAttachments } from "#server/content/historyAttachments.ts";
import { runStaticExport } from "#server/export/exportPipeline.ts";
import { prepareHistoryPresentation } from "#server/history/historyPresentation.ts";
import { historyItemAttachments } from "#shared/timeline/historyAttachments.ts";
import { historyItemMarkdown } from "#shared/timeline/historyPresentation.ts";
import type { HistoryPresentationRequest } from "#shared/types/history.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

it("publishes retained inline and managed copies, qualifies cloud and deleted references without widening local authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "viewer-reference-lifecycle-"));
  const codexHome = join(root, "home");
  const cacheDir = join(root, "cache");
  const outputRoot = join(root, "output");
  const managed = join(codexHome, "attachments/managed.png");
  const original = join(root, "original.png");
  const outside = join(root, "unapproved.png");
  const deleted = join(codexHome, "attachments/deleted.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(codexHome, "attachments"), { recursive: true });
  await writeFile(original, png);
  await writeFile(managed, await readFile(original));
  await writeFile(outside, png);
  await rm(original);
  const records = [
    { type: "session_meta", payload: { id, source: "cli", thread_source: "user" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Preserve recorded references",
        local_images: [managed, deleted, outside],
        images: ["sediment:cloud-without-bytes"],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "image_generation_call",
        id: "generated",
        result: png.toString("base64"),
        saved_path: original,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Saved result" }],
      },
    },
    {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn", last_agent_message: "Saved result" },
    },
  ];
  await writeFile(
    join(codexHome, `sessions/rollout-${id}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  const paths = {
    cacheDir,
    cacheDatabase: join(cacheDir, "viewer.sqlite"),
    configDir: join(root, "config"),
    configFile: join(root, "config/config.json"),
    generatedDir: join(root, "generated"),
  };
  try {
    await runStaticExport({
      codexHome,
      paths,
      outputRoot,
      generatedRoot: paths.generatedDir,
      offline: true,
      index: false,
      generate: async ({ outputRoot: destination }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(
          join(destination, "index.html"),
          "<!doctype html><title>Fixture shell</title>",
        );
      },
    });
    const repository = new StaticConversationRepository(
      async (path) => JSON.parse(await readFile(join(outputRoot, path), "utf8")) as unknown,
    );
    const history = await repository.getHistoryPage(id, { anchor: { kind: "latest" } });
    const turn = history.turns[0]!;
    const user = turn.opening.item!;
    const generated = turn.items.find(({ item }) => item?.type === "imageGeneration")!.item!;
    const request = (item: typeof user): HistoryPresentationRequest => ({
      threadId: id,
      historyEpoch: history.historyEpoch,
      contentRevision: history.contentRevision,
      physicalRolloutId: turn.physicalRolloutId,
      turnId: turn.turnId,
      itemId: item.id,
      markdown: historyItemMarkdown(item)!,
      attachments: historyItemAttachments(item),
    });
    const userQuery = request(user);
    const saved = await repository.prepareHistoryPresentation(userQuery);
    const media = saved.body.children.filter((node) => node.type === "media");
    expect(media).toHaveLength(4);
    const assets = await Promise.all(media.map((node) => repository.resolveAsset(node.assetId!)));
    expect(assets.map((asset) => asset.status)).toEqual(["error", "available", "missing", "error"]);
    expect(assets[1]?.originalPath).toBe(managed);
    expect(await readFile(join(outputRoot, assets[1]!.url!))).toEqual(png);
    const generatedPresentation = await repository.prepareHistoryPresentation(request(generated));
    const generatedNode = generatedPresentation.body.children.find(
      (node) => node.type === "media",
    )!;
    if (generatedNode.type !== "media") {
      throw new Error("Expected generated image node");
    }
    const retained = await repository.resolveAsset(generatedNode.assetId!);
    expect(retained.status).toBe("available");
    expect(await readFile(join(outputRoot, retained.url!))).toEqual(png);
    const database = openCacheDatabase(paths.cacheDatabase);
    try {
      const live = await prepareHistoryPresentation(userQuery, undefined, {
        cacheScope: `lifecycle:${root}`,
        storeEmbeddedMedia: async () => {},
        prepareAttachments: (attachments) =>
          prepareHistoryAttachments(database, attachments, {
            assetRoot: join(cacheDir, "assets"),
            sessionId: id,
            trustedMediaRoots: [join(codexHome, "attachments")],
          }),
      });
      expect(live.body).toEqual(saved.body);
    } finally {
      database.close();
    }
    await rm(managed);
    expect(await readFile(join(outputRoot, assets[1]!.url!))).toEqual(png);
    expect(await readFile(outside)).toEqual(png);
    await expect(
      repository.prepareHistoryPresentation({ ...userQuery, attachments: [] }),
    ).rejects.toThrow("history.static_presentation_missing");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);
