import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { expect, it } from "vitest";

import { runStaticExport } from "#server/export/exportPipeline.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

it.each(["unsupported", "malformed", "unfinished", "oversized-inline-image"])(
  "qualifies retained export records with %s source coverage",
  async (condition) => {
    const root = await mkdtemp(join(tmpdir(), "viewer-export-coverage-"));
    const codexHome = join(root, "home");
    const cacheDir = join(root, "cache");
    const outputRoot = join(root, "output");
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const pngText = Buffer.from(`Comment\0${"x".repeat(1024 * 1024)}`);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(pngText.length);
    const textChunk = Buffer.concat([Buffer.from("tEXt"), pngText]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(textChunk));
    const oversizedPng = Buffer.concat([
      pixel.subarray(0, -12),
      length,
      textChunk,
      checksum,
      pixel.subarray(-12),
    ]);
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    const records = [
      { type: "session_meta", payload: { id, source: "cli", thread_source: "user" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "event_msg", payload: { type: "user_message", message: "Known valid prompt" } },
      ...(condition === "unsupported"
        ? [
            {
              type: "event_msg",
              payload: {
                type: "item_completed",
                turn_id: "turn",
                item: { type: "FutureItem", id: "unsupported", content: "Preserved raw evidence" },
              },
            },
          ]
        : []),
      ...(condition === "oversized-inline-image"
        ? [
            {
              type: "response_item",
              payload: {
                type: "image_generation_call",
                id: "oversized-image",
                result: oversizedPng.toString("base64"),
              },
            },
          ]
        : []),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Known valid answer" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn",
          last_agent_message: "Known valid answer",
        },
      },
    ];
    await writeFile(
      join(codexHome, `sessions/rollout-${id}.jsonl`),
      records.map((record) => JSON.stringify(record)).join("\n") +
        "\n" +
        (condition === "malformed" ? "{broken}\n" : condition === "unfinished" ? '{"type":' : ""),
    );
    const paths = {
      cacheDir,
      cacheDatabase: join(cacheDir, "viewer.sqlite"),
      configDir: join(root, "config"),
      configFile: join(root, "config/config.json"),
      generatedDir: join(root, "generated"),
    };
    try {
      const exported = await runStaticExport({
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
      expect(exported.sessionCount).toBe(1);
      expect(exported.diagnosticCounts["source.invalid_jsonl"]).toBeGreaterThan(0);
      const repository = new StaticConversationRepository(
        async (path) => JSON.parse(await readFile(join(outputRoot, path), "utf8")) as unknown,
      );
      expect((await repository.getSession(id)).diagnosticCount).toBeGreaterThan(0);
      expect(JSON.stringify(await repository.getTurns(id, { limit: 20 }))).toContain(
        "Known valid answer",
      );
      if (condition === "unsupported") {
        const history = await repository.getHistoryPage(id, { anchor: { kind: "latest" } });
        expect(history.coverage.status).toBe("partial");
        expect(history.preparation).toBe("partial");
        expect(history.coverage.gaps.length).toBeGreaterThan(0);
      } else {
        expect(await repository.supportsHistory(id)).toBe(false);
        await expect(
          repository.getHistoryPage(id, { anchor: { kind: "latest" } }),
        ).rejects.toMatchObject({ code: "history.unsupported" });
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
