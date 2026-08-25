import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseVerifyOutputArguments,
  verifyGeneratedOutput,
} from "../../../server/export/verifyOutput.ts";
import {
  driftOutputDiagnosticCount,
  rewriteOutputJson,
  writeValidOutputFixture,
} from "../../fixtures/output.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function validOutput(): Promise<{ root: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-output-verification-"));
  temporaryDirectories.push(root);
  return writeValidOutputFixture(root);
}

async function rewriteJson(
  path: string,
  update: (value: Record<string, unknown>) => void,
): Promise<void> {
  await rewriteOutputJson(path, update);
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

  it("rejects diagnostic-count drift in the shared structurally complete fixture", async () => {
    const { root } = await validOutput();
    await driftOutputDiagnosticCount(root);

    await expect(verifyGeneratedOutput(root)).rejects.toThrow(
      "Session diagnostics do not match the indexed diagnostic count",
    );
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

  it("requires the generated project catalog and excludes guardian sessions", async () => {
    const missingProjects = await validOutput();
    await rm(join(missingProjects.root, "payloads", "projects.json"));
    await expect(verifyGeneratedOutput(missingProjects.root)).rejects.toThrow(
      "payloads/projects.json",
    );

    const guardian = await validOutput();
    const indexPath = join(guardian.root, "payloads", "sessions", "index.json");
    await rewriteJson(indexPath, (value) => {
      const summary = (value["sessions"] as Array<Record<string, unknown>>)[0]!;
      summary["models"] = ["codex-auto-review"];
    });
    await expect(verifyGeneratedOutput(guardian.root)).rejects.toThrow(
      "Auxiliary guardian session crossed",
    );
  });

  it("rejects missing and cyclic subagent parent edges", async () => {
    const missingParent = await validOutput();
    const missingIndexPath = join(missingParent.root, "payloads", "sessions", "index.json");
    const missingSummaryPath = join(
      missingParent.root,
      "payloads",
      "sessions",
      missingParent.sessionId,
      "summary.json",
    );
    const missingProjectsPath = join(missingParent.root, "payloads", "projects.json");
    await Promise.all(
      [missingIndexPath, missingSummaryPath].map((path) =>
        rewriteJson(path, (value) => {
          const summary =
            "sessions" in value
              ? (value["sessions"] as Array<Record<string, unknown>>)[0]!
              : (value["summary"] as Record<string, unknown>);
          summary["parentThreadId"] = "missing-parent";
        }),
      ),
    );
    await rewriteJson(missingProjectsPath, (value) => {
      const entry = (value["entries"] as Record<string, Record<string, unknown>>)[
        missingParent.sessionId
      ]!;
      entry["kind"] = "subagent";
      entry["parentThreadId"] = "missing-parent";
      entry["agentDepth"] = 1;
    });
    await expect(verifyGeneratedOutput(missingParent.root)).rejects.toThrow(
      "missing its parent edge",
    );

    const cycle = await validOutput();
    const cycleIndexPath = join(cycle.root, "payloads", "sessions", "index.json");
    const cycleSummaryPath = join(
      cycle.root,
      "payloads",
      "sessions",
      cycle.sessionId,
      "summary.json",
    );
    await Promise.all(
      [cycleIndexPath, cycleSummaryPath].map((path) =>
        rewriteJson(path, (value) => {
          const summary =
            "sessions" in value
              ? (value["sessions"] as Array<Record<string, unknown>>)[0]!
              : (value["summary"] as Record<string, unknown>);
          summary["parentThreadId"] = cycle.sessionId;
          summary["childThreadIds"] = [cycle.sessionId];
        }),
      ),
    );
    await rewriteJson(join(cycle.root, "payloads", "projects.json"), (value) => {
      const entry = (value["entries"] as Record<string, Record<string, unknown>>)[cycle.sessionId]!;
      entry["kind"] = "subagent";
      entry["parentThreadId"] = cycle.sessionId;
      entry["agentDepth"] = 1;
      entry["childCount"] = 1;
    });
    await expect(verifyGeneratedOutput(cycle.root)).rejects.toThrow("topology contains a cycle");
  });

  it("rejects missing entry-order references and a mismatched final response", async () => {
    const missingEntry = await validOutput();
    const missingTurnPath = join(
      missingEntry.root,
      "payloads",
      "sessions",
      missingEntry.sessionId,
      "turn-0.json",
    );
    await rewriteJson(missingTurnPath, (value) => {
      const turn = (value["turns"] as Array<Record<string, unknown>>)[0]!;
      (turn["entryOrder"] as unknown[]).pop();
    });
    await expect(verifyGeneratedOutput(missingEntry.root)).rejects.toThrow(
      "chronological entry order does not match",
    );

    const mismatchedFinal = await validOutput();
    const finalTurnPath = join(
      mismatchedFinal.root,
      "payloads",
      "sessions",
      mismatchedFinal.sessionId,
      "turn-0.json",
    );
    await rewriteJson(finalTurnPath, (value) => {
      const turn = (value["turns"] as Array<Record<string, unknown>>)[0]!;
      turn["finalAssistantMessageId"] = null;
    });
    await expect(verifyGeneratedOutput(mismatchedFinal.root)).rejects.toThrow(
      "final assistant ID does not match",
    );
  });

  it("rejects a steering message without matching inspector evidence", async () => {
    const missingSteeringInspector = await validOutput();
    const turnPath = join(
      missingSteeringInspector.root,
      "payloads",
      "sessions",
      missingSteeringInspector.sessionId,
      "turn-0.json",
    );
    await rewriteJson(turnPath, (value) => {
      const turn = (value["turns"] as Array<Record<string, unknown>>)[0]!;
      const userMessage = turn["userMessage"] as Record<string, unknown>;
      turn["steeringMessages"] = [
        {
          ...userMessage,
          id: "steering-without-inspector",
          sourceMarkdown: "Please keep the existing API.",
        },
      ];
      (turn["entryOrder"] as unknown[]).push({
        kind: "message",
        id: "steering-without-inspector",
      });
    });

    await expect(verifyGeneratedOutput(missingSteeringInspector.root)).rejects.toThrow(
      "Inspector records do not match their turn chunk",
    );
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
