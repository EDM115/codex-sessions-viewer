import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendPagefindRecords,
  buildPagefind,
  buildPagefindRecordSpool,
  createPagefindTurnRecords,
} from "../../../server/export/buildPagefind.ts";
import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Pagefind offline bundle", () => {
  it("writes a local browser index from custom turn records", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-pagefind-"));
    temporaryDirectories.push(root);
    const outputPath = join(root, "public", "pagefind");
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:fixture",
    });

    const result = await buildPagefind([conversation], outputPath);
    await writeFile(join(outputPath, "stale-fragment.pf"), "obsolete");
    const rebuilt = await buildPagefind([conversation], outputPath);
    const files = await readdir(outputPath, { recursive: true });

    expect(result).toMatchObject({ recordCount: 2, outputPath });
    expect(rebuilt).toMatchObject({ recordCount: 2, outputPath });
    expect(files).toContain("pagefind.js");
    expect(files).not.toContain("stale-fragment.pf");
    expect(files.some((path) => path.includes("wasm"))).toBe(true);
    expect(files.some((path) => path.startsWith("pagefind-entry.json"))).toBe(true);
  }, 30_000);

  it("streams a validated JSONL record spool into the local browser index", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-pagefind-spool-"));
    temporaryDirectories.push(root);
    const outputPath = join(root, "public", "pagefind");
    const spoolPath = join(root, "records.jsonl");
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:spool-fixture",
    });
    const records = createPagefindTurnRecords([conversation]);
    records[0]!.content += "\nUnicode separators stay inside JSON strings: \u2028 and \u2029.";
    await writeFile(spoolPath, "", "utf8");
    await appendPagefindRecords(spoolPath, records.slice(0, 1));
    await appendPagefindRecords(spoolPath, records.slice(1));
    const progress: number[] = [];
    let finalizing = false;

    const result = await buildPagefindRecordSpool(spoolPath, records.length, outputPath, {
      onRecordProgress(completed) {
        progress.push(completed);
      },
      onWriteStart() {
        finalizing = true;
      },
    });

    expect(result).toMatchObject({ recordCount: 2, outputPath });
    expect(progress).toEqual([1, 2]);
    expect(finalizing).toBe(true);
    expect(await readdir(outputPath, { recursive: true })).toContain("pagefind.js");
  }, 30_000);
});
