import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidStaticPayloadPathError,
  readStaticPayloadInput,
} from "../../../server/export/staticPayloadInput.ts";

const roots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-static-payload-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("static prerender payload input", () => {
  it("reads generated JSON beneath the isolated payload root", async () => {
    const root = await createTempRoot();
    const sessionRoot = join(root, "payloads", "sessions", "session-1");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, "summary.json"), '{"summary":{"id":"session-1"}}');

    await expect(readStaticPayloadInput(root, "sessions/session-1/summary.json")).resolves.toEqual({
      summary: { id: "session-1" },
    });
  });

  it.each(["", "../outside.json", "sessions\\outside.json", "sessions/./outside.json"])(
    "rejects an unsafe payload path: %s",
    async (requestPath) => {
      const root = await createTempRoot();

      await expect(readStaticPayloadInput(root, requestPath)).rejects.toBeInstanceOf(
        InvalidStaticPayloadPathError,
      );
    },
  );
});
