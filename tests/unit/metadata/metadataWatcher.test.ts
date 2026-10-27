import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import {
  watchSources,
  type SourceWatcher,
  type SourceWatchBatch,
} from "../../../server/ingestion/watchSources.ts";

it("watches atomic metadata replacement and WAL creation without subscribing to rollout trees", async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "viewer-metadata-watch-"));
  let watcher: SourceWatcher | undefined;
  try {
    await mkdir(join(home, "sessions"));
    const rollout = join(home, "sessions", "selected.jsonl");
    const global = join(home, ".codex-global-state.json");
    const wal = join(home, "state_5.sqlite-wal");
    await writeFile(rollout, "{}\n");
    await writeFile(global, "{}");
    const batches: SourceWatchBatch[] = [];
    watcher = watchSources({
      codexHome: home,
      metadataOnly: true,
      debounceMs: 20,
      onBatch(batch) {
        batches.push(batch);
      },
    });
    await watcher.ready;
    await appendFile(rollout, "{}\n");
    await writeFile(wal, "wal");
    await writeFile(`${global}.tmp`, '{"projectless-thread-ids":["new"]}');
    await rename(`${global}.tmp`, global);
    await vi.waitFor(
      () => {
        expect(batches.flatMap(({ changes }) => changes).map(({ path }) => path)).toContain(wal);
        expect(batches.flatMap(({ changes }) => changes).some(({ path }) => path === global)).toBe(
          true,
        );
      },
      { timeout: 3000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(batches.flatMap(({ changes }) => changes).map(({ source }) => source)).not.toContain(
      "rollout",
    );
  } finally {
    await watcher?.close();
    await rm(home, { recursive: true, force: true });
  }
});
