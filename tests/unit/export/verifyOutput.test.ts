import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseVerifyOutputArguments,
  verifyGeneratedOutput,
} from "../../../server/export/verifyOutput.ts";
import { writeConversationExport } from "../../../server/export/writeConversationExport.ts";
import { writeStaticPayloads } from "../../../server/export/writeStaticPayloads.ts";
import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function validOutput(): Promise<{ root: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-output-verification-"));
  temporaryDirectories.push(root);
  const conversation = await normalizedRolloutFixture({
    name: "modern.jsonl",
    sourcePath: join(root, "modern.jsonl"),
    scope: "active",
    revision: "sha256:verified-output",
  });
  const sessionId = conversation.summary.id;
  await writeStaticPayloads([conversation], { generatedRoot: root, chunkSize: 1 });
  await writeConversationExport(conversation, { generatedRoot: root, publicRoot: root });
  await Promise.all([
    mkdir(join(root, "_nuxt"), { recursive: true }),
    mkdir(join(root, "session", sessionId), { recursive: true }),
  ]);
  const html =
    '<!doctype html><html><head><link rel="stylesheet" href="/_nuxt/app.css"></head><body></body></html>';
  await Promise.all([
    writeFile(join(root, "index.html"), html),
    writeFile(join(root, "session", sessionId, "index.html"), html),
    writeFile(join(root, "_nuxt", "app.css"), "body { overflow-x: clip; }"),
    writeFile(join(root, "payloads", "export.json"), '{"version":1,"pagefind":false}\n'),
    writeFile(join(root, "payloads", "assets.json"), '{"version":1,"assets":[]}\n'),
    writeFile(join(root, "payloads", "favicons.json"), '{"version":1,"favicons":[]}\n'),
  ]);
  return { root, sessionId };
}

async function rewriteJson(
  path: string,
  update: (value: Record<string, unknown>) => void,
): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  update(value);
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

describe("generated output verification", () => {
  it("parses the optional output path without accepting unrelated flags", () => {
    expect(parseVerifyOutputArguments([])).toEqual({ output: ".output/public" });
    expect(parseVerifyOutputArguments(["--output", "C:\\viewer output"])).toEqual({
      output: "C:\\viewer output",
    });
    expect(parseVerifyOutputArguments(["--output=C:\\viewer output"])).toEqual({
      output: "C:\\viewer output",
    });
    expect(() => parseVerifyOutputArguments(["--output"])).toThrow("requires a value");
    expect(() => parseVerifyOutputArguments(["--output="])).toThrow("requires a value");
    expect(() => parseVerifyOutputArguments(["--output", "one", "two"])).toThrow("Unknown option");
    expect(() => parseVerifyOutputArguments(["--output=one", "two"])).toThrow("Unknown option");
    expect(() => parseVerifyOutputArguments(["--force"])).toThrow("Unknown option");
  });

  it("validates complete chunked payloads, Markdown, routes, manifests, and local resources", async () => {
    const { root } = await validOutput();

    await expect(verifyGeneratedOutput(root)).resolves.toEqual({
      publicRoot: root,
      sessionCount: 1,
      turnCount: 2,
      assetCount: 0,
      faviconCount: 0,
      searchIndex: false,
      checkedFiles: expect.any(Number),
    });
  });

  it("rejects a turn chunk that no longer matches its navigator", async () => {
    const { root, sessionId } = await validOutput();
    const chunkPath = join(root, "payloads", "sessions", sessionId, "turn-0.json");
    const chunk = JSON.parse(await readFile(chunkPath, "utf8")) as Record<string, unknown>;
    chunk["turns"] = [];
    await writeFile(chunkPath, `${JSON.stringify(chunk)}\n`);

    await expect(verifyGeneratedOutput(root)).rejects.toThrow(
      "Turn chunks do not match the navigator",
    );
  });

  it("rejects an automatic external resource in generated HTML", async () => {
    const { root } = await validOutput();
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><body><script src="https://cdn.example.test/app.js"></script></body></html>',
    );

    await expect(verifyGeneratedOutput(root)).rejects.toThrow(
      "Generated HTML references an external automatic resource",
    );
  });

  it("rejects an external automatic resource in generated CSS", async () => {
    const { root } = await validOutput();
    await writeFile(join(root, "_nuxt", "app.css"), '@import "//cdn.example.test/app.css";');

    await expect(verifyGeneratedOutput(root)).rejects.toThrow(
      "Generated CSS references an external automatic resource",
    );
  });

  it("rejects unreadable, invalid, and duplicate top-level manifests", async () => {
    const unreadable = await validOutput();
    await writeFile(join(unreadable.root, "payloads", "export.json"), "{");
    await expect(verifyGeneratedOutput(unreadable.root)).rejects.toThrow("unreadable JSON");

    const invalid = await validOutput();
    await writeFile(
      join(invalid.root, "payloads", "export.json"),
      '{"version":2,"pagefind":false}\n',
    );
    await expect(verifyGeneratedOutput(invalid.root)).rejects.toThrow("invalid JSON");

    const duplicate = await validOutput();
    const indexPath = join(duplicate.root, "payloads", "sessions", "index.json");
    await rewriteJson(indexPath, (value) => {
      const sessions = value["sessions"] as unknown[];
      sessions.push(structuredClone(sessions[0]));
    });
    await expect(verifyGeneratedOutput(duplicate.root)).rejects.toThrow("duplicate session IDs");
  });

  it("rejects summary and navigator drift from the session index", async () => {
    const summaryDrift = await validOutput();
    const summaryPath = join(
      summaryDrift.root,
      "payloads",
      "sessions",
      summaryDrift.sessionId,
      "summary.json",
    );
    await rewriteJson(summaryPath, (value) => {
      (value["summary"] as Record<string, unknown>)["revision"] = "sha256:other";
    });
    await expect(verifyGeneratedOutput(summaryDrift.root)).rejects.toThrow(
      "Session summary does not match",
    );

    const countDrift = await validOutput();
    const navigatorPath = join(
      countDrift.root,
      "payloads",
      "sessions",
      countDrift.sessionId,
      "navigator.json",
    );
    await rewriteJson(navigatorPath, (value) => {
      (value["items"] as unknown[]).pop();
    });
    await expect(verifyGeneratedOutput(countDrift.root)).rejects.toThrow("indexed turn count");

    const duplicateTurn = await validOutput();
    const duplicateNavigatorPath = join(
      duplicateTurn.root,
      "payloads",
      "sessions",
      duplicateTurn.sessionId,
      "navigator.json",
    );
    await rewriteJson(duplicateNavigatorPath, (value) => {
      const items = value["items"] as Array<Record<string, unknown>>;
      items[1]!["turnId"] = items[0]!["turnId"];
    });
    await expect(verifyGeneratedOutput(duplicateTurn.root)).rejects.toThrow("duplicate turn IDs");
  });

  it("rejects inspector records that do not exactly match their turn chunk", async () => {
    const { root, sessionId } = await validOutput();
    const inspectorPath = join(root, "payloads", "sessions", sessionId, "inspector-0.json");
    await rewriteJson(inspectorPath, (value) => {
      (value["records"] as unknown[]).pop();
    });

    await expect(verifyGeneratedOutput(root)).rejects.toThrow(
      "Inspector records do not match their turn chunk",
    );
  });

  it("rejects missing or mismatched inspector raw-event pool entries", async () => {
    const missing = await validOutput();
    const missingInspectorPath = join(
      missing.root,
      "payloads",
      "sessions",
      missing.sessionId,
      "inspector-0.json",
    );
    await rewriteJson(missingInspectorPath, (value) => {
      const rawRecords = value["rawRecords"] as Record<string, unknown>;
      delete rawRecords[Object.keys(rawRecords)[0]!];
    });
    await expect(verifyGeneratedOutput(missing.root)).rejects.toThrow(
      "Inspector raw-record pool does not match its records",
    );

    const mismatched = await validOutput();
    const mismatchedInspectorPath = join(
      mismatched.root,
      "payloads",
      "sessions",
      mismatched.sessionId,
      "inspector-0.json",
    );
    await rewriteJson(mismatchedInspectorPath, (value) => {
      const rawRecords = value["rawRecords"] as Record<string, Record<string, unknown>>;
      const eventId = Object.keys(rawRecords)[0]!;
      rawRecords[eventId]!["id"] = "different-event";
    });
    await expect(verifyGeneratedOutput(mismatched.root)).rejects.toThrow(
      "Inspector raw-record pool contains a mismatched event",
    );
  });

  it("rejects an inspector target mapped to the wrong chunk", async () => {
    const { root, sessionId } = await validOutput();
    const navigatorPath = join(root, "payloads", "sessions", sessionId, "navigator.json");
    await rewriteJson(navigatorPath, (value) => {
      const inspectorChunks = value["inspectorChunks"] as Record<string, number>;
      inspectorChunks[Object.keys(inspectorChunks)[0]!] = 99;
    });

    await expect(verifyGeneratedOutput(root)).rejects.toThrow(
      "Inspector chunk index does not match inspector payloads",
    );
  });

  it("verifies available asset bytes and rejects manifest/content disagreement", async () => {
    const { root } = await validOutput();
    const bytes = Buffer.from("verified local asset");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", `${sha256}.txt`), bytes);
    await writeFile(
      join(root, "payloads", "assets.json"),
      `${JSON.stringify({
        version: 1,
        assets: [
          {
            id: "asset-verified",
            url: `/assets/${sha256}.txt`,
            mimeType: "text/plain",
            byteSize: bytes.byteLength,
            sha256,
            width: null,
            height: null,
            status: "available",
            originalPath: "C:\\source.txt",
          },
        ],
      })}\n`,
    );

    await expect(verifyGeneratedOutput(root)).resolves.toMatchObject({ assetCount: 1 });
    await writeFile(join(root, "assets", `${sha256}.txt`), "corrupt");
    await expect(verifyGeneratedOutput(root)).rejects.toThrow("unexpected byte size");
  });

  it("requires unavailable assets to remain unpublished", async () => {
    const { root } = await validOutput();
    await writeFile(
      join(root, "payloads", "assets.json"),
      `${JSON.stringify({
        version: 1,
        assets: [
          {
            id: "asset-missing",
            url: "/assets/missing.bin",
            mimeType: null,
            byteSize: null,
            sha256: null,
            width: null,
            height: null,
            status: "missing",
            originalPath: null,
          },
        ],
      })}\n`,
    );

    await expect(verifyGeneratedOutput(root)).rejects.toThrow(
      "Unavailable generated asset has a published URL",
    );
  });

  it("requires a complete Pagefind runtime only when search is enabled", async () => {
    const missing = await validOutput();
    await writeFile(
      join(missing.root, "payloads", "export.json"),
      '{"version":1,"pagefind":true}\n',
    );
    await expect(verifyGeneratedOutput(missing.root)).rejects.toThrow("pagefind/pagefind.js");

    const complete = await validOutput();
    await writeFile(
      join(complete.root, "payloads", "export.json"),
      '{"version":1,"pagefind":true}\n',
    );
    await mkdir(join(complete.root, "pagefind"), { recursive: true });
    await writeFile(join(complete.root, "pagefind", "pagefind.js"), "export const version = 1;");
    await expect(verifyGeneratedOutput(complete.root)).rejects.toThrow("WebAssembly runtime");
    await writeFile(
      join(complete.root, "pagefind", "wasm.en.pagefind"),
      Buffer.from([0, 97, 115, 109]),
    );
    await expect(verifyGeneratedOutput(complete.root)).resolves.toMatchObject({
      searchIndex: true,
    });
  });

  it("rejects hard-linked files anywhere in the published tree", async () => {
    const { root } = await validOutput();
    await link(join(root, "index.html"), join(root, "linked-index.html"));

    await expect(verifyGeneratedOutput(root)).rejects.toThrow("linked file");
  });
});
