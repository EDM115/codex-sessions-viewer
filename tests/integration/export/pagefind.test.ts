import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPagefind } from "../../../server/export/buildPagefind.ts";
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
});
