import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  StaticConversationRepository,
  type PagefindBrowserApi,
} from "../../../app/repositories/static.ts";
import {
  appendPagefindRecords,
  buildPagefind,
  buildPagefindRecordSpool,
  createPagefindTurnRecords,
} from "../../../server/export/buildPagefind.ts";
import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

const temporaryDirectories: string[] = [];
type InspectablePagefind = PagefindBrowserApi & {
  filters(): Promise<Record<string, Record<string, number>>>;
};

async function loadGeneratedPagefind(path: string): Promise<InspectablePagefind> {
  const loaded: unknown = await import(pathToFileURL(path).href);
  if (
    loaded === null ||
    typeof loaded !== "object" ||
    !("search" in loaded) ||
    typeof loaded.search !== "function" ||
    !("filters" in loaded) ||
    typeof loaded.filters !== "function"
  ) {
    throw new Error("Generated Pagefind module does not expose search().");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The generated module boundary is checked above and result data is validated by the repository.
  return loaded as InspectablePagefind;
}

async function withFileFetch<T>(action: () => Promise<T>): Promise<T> {
  const browserFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "file:") {
      return browserFetch(input, init);
    }
    url.search = "";
    const bytes = await readFile(fileURLToPath(url));
    return new Response(bytes, {
      headers: {
        "Content-Type": url.pathname.endsWith(".wasm")
          ? "application/wasm"
          : "application/octet-stream",
      },
    });
  };
  try {
    return await action();
  } finally {
    globalThis.fetch = browserFetch;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Pagefind offline bundle", () => {
  it("retains parent identity in static child search records", async () => {
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixtures/child.jsonl",
      scope: "active",
      revision: "sha256:child-search",
    });
    conversation.summary.parentThreadId = "parent-thread";
    const records = createPagefindTurnRecords([conversation]);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.meta?.["parentThreadId"] === "parent-thread")).toBe(
      true,
    );
  });

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
    records[0].content += "\nUnicode separators stay inside JSON strings: \u2028 and \u2029.";
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

  it("searches a later turn through session-level filters and preserves its exact destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-pagefind-parity-"));
    temporaryDirectories.push(root);
    const outputPath = join(root, "public", "pagefind");
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:parity-fixture",
    });
    await buildPagefind([conversation], outputPath);
    const pagefind = await loadGeneratedPagefind(join(outputPath, "pagefind.js"));
    const repository = new StaticConversationRepository(
      async () => {
        throw new Error("Static payloads are not needed for this search.");
      },
      async () => pagefind,
    );

    const baseQuery = { scope: "active" as const, query: "Handle cancellation" };
    const [availableFilters, results, rejected] = await withFileFetch(async () => {
      const filters = await pagefind.filters();
      const searches = [
        await repository.search(baseQuery),
        await repository.search({ ...baseQuery, model: "gpt-exact-1" }),
        await repository.search({
          ...baseQuery,
          model: "gpt-exact-1",
          cwd: "C:\\work\\viewer",
        }),
        await repository.search({
          ...baseQuery,
          model: "gpt-exact-1",
          cwd: "C:\\work\\viewer",
          tool: "filesystem.read_file",
        }),
        await repository.search({
          ...baseQuery,
          model: "gpt-exact-1",
          cwd: "C:\\work\\viewer",
          tool: "filesystem.read_file",
          hasMedia: true,
        }),
      ];
      const excluded = [
        await repository.search({ ...baseQuery, scope: "archived" }),
        await repository.search({ ...baseQuery, model: "other-model" }),
        await repository.search({ ...baseQuery, cwd: "D:\\other-project" }),
        await repository.search({ ...baseQuery, tool: "other-tool" }),
        await repository.search({ ...baseQuery, hasMedia: false }),
      ];
      return [filters, searches, excluded] as const;
    });
    expect(availableFilters).toHaveProperty(["cwd", "C%3A%5Cwork%5Cviewer"], 2);
    expect(results.map(({ total }) => total)).toEqual([1, 1, 1, 1, 1]);
    expect(rejected.map(({ total, items }) => ({ total, items }))).toEqual(
      Array.from({ length: 5 }, () => ({ total: 0, items: [] })),
    );
    const result = results.at(-1)!;

    expect(result).toMatchObject({
      total: 1,
      nextCursor: null,
      items: [
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          turnId: "turn-2",
          messageId: conversation.turns[1]?.userMessage?.id,
          scope: "active",
          title: "Build the parser",
        },
      ],
    });
    expect(result.items[0]?.excerpt).toContain("cancellation");
  }, 30_000);
});
