import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { expect, it } from "vitest";

import { runStaticExport } from "#server/export/exportPipeline.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

it("reconciles an unavailable new history without republishing the old generation and preserves output on failed publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "viewer-export-repeated-history-"));
  const codexHome = join(root, "home");
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const source = join(codexHome, `sessions/rollout-${id}.jsonl`);
  const outputRoot = join(root, "output");
  const paths = {
    cacheDir: join(root, "cache"),
    cacheDatabase: join(root, "cache/viewer.sqlite"),
    configDir: join(root, "config"),
    configFile: join(root, "config/config.json"),
    generatedDir: join(root, "generated"),
  };
  const generate = async ({ outputRoot: destination }: { outputRoot: string }) => {
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "index.html"), "<!doctype html><title>Fixture shell</title>");
  };
  const options = {
    codexHome,
    paths,
    outputRoot,
    generatedRoot: paths.generatedDir,
    offline: true,
    index: false,
    generate,
  };
  const repository = () =>
    new StaticConversationRepository(
      async (path) => JSON.parse(await readFile(join(outputRoot, path), "utf8")) as unknown,
    );
  const records = (answer: string) =>
    [
      { type: "session_meta", payload: { id, source: "cli", thread_source: "user" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "event_msg", payload: { type: "user_message", message: "Known prompt" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: answer }],
        },
      },
      {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn", last_agent_message: answer },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
  try {
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await writeFile(source, records("ANSWER_A"));
    await runStaticExport(options);
    const initial = await repository().getHistoryPage(id, { anchor: { kind: "latest" } });
    expect(initial.coverage.status).toBe("complete");
    expect(JSON.stringify(initial)).toContain("ANSWER_A");
    const publishedManifest = await readFile(
      join(outputRoot, `payloads/sessions/${id}/history-index.json`),
      "utf8",
    );
    await writeFile(source, records("ANSWER_B") + "{broken}\n");
    await expect(
      runStaticExport({
        ...options,
        generate: async () => {
          throw new Error("fixture.publication_failed");
        },
      }),
    ).rejects.toThrow("fixture.publication_failed");
    expect(
      await readFile(join(outputRoot, `payloads/sessions/${id}/history-index.json`), "utf8"),
    ).toBe(publishedManifest);
    expect(JSON.stringify(await repository().getTurns(id, { limit: 20 }))).toContain("ANSWER_A");
    const exported = await runStaticExport(options);
    expect(exported.sessionCount).toBe(1);
    expect(exported.diagnosticCounts["source.invalid_jsonl"]).toBeGreaterThan(0);
    const current = repository();
    expect(await current.supportsHistory(id)).toBe(false);
    await expect(current.getHistoryPage(id, { anchor: { kind: "latest" } })).rejects.toMatchObject({
      code: "history.unsupported",
    });
    const retained = JSON.stringify(await current.getTurns(id, { limit: 20 }));
    expect(retained).toContain("ANSWER_B");
    expect(retained).not.toContain("ANSWER_A");
    expect((await current.getSession(id)).diagnosticCount).toBeGreaterThan(0);
    expect((await current.listSessions({ scope: "active", model: "absent-model" })).total).toBe(0);
    expect((await current.listSessions({ scope: "active", tool: "absent-tool" })).total).toBe(0);
    expect((await current.listSessions({ scope: "active", hasMedia: true })).total).toBe(0);
    expect(
      (await current.listSessions({ scope: "active", hasMedia: false })).items.map(
        ({ id: threadId }) => threadId,
      ),
    ).toEqual([id]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

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
