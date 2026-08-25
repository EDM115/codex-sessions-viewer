import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeConversationExport } from "../../server/export/writeConversationExport.ts";
import { writeStaticPayloads } from "../../server/export/writeStaticPayloads.ts";
import { normalizedRolloutFixture } from "./cache/normalized.ts";

export async function writeValidOutputFixture(
  root: string,
): Promise<{ root: string; sessionId: string }> {
  const conversation = await normalizedRolloutFixture({
    name: "modern.jsonl",
    sourcePath: join(root, "modern.jsonl"),
    scope: "active",
    revision: "sha256:verified-output",
  });
  conversation.summary.parentThreadId = null;
  conversation.summary.childThreadIds = [];
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

export async function rewriteOutputJson(
  path: string,
  update: (value: Record<string, unknown>) => void,
): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  update(value);
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

export async function driftOutputDiagnosticCount(root: string): Promise<void> {
  await rewriteOutputJson(join(root, "payloads", "sessions", "index.json"), (value) => {
    const summary = (value["sessions"] as Array<Record<string, unknown>>)[0]!;
    summary["diagnosticCount"] = Number(summary["diagnosticCount"]) + 1;
  });
}
