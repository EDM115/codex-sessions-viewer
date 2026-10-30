import { opendir } from "node:fs/promises";
import { join } from "node:path";

import type { DiscoveredRolloutSource } from "#server/ingestion/discoverSources.ts";

// Stream directory entries instead of allocating the entire archive or reading transcript bodies
export async function* recoverCatalogSources(
  home: string,
  signal: AbortSignal,
): AsyncGenerator<DiscoveredRolloutSource[]> {
  let batch: DiscoveredRolloutSource[] = [];
  async function* walk(
    path: string,
    scope: DiscoveredRolloutSource["scope"],
  ): AsyncGenerator<DiscoveredRolloutSource[]> {
    signal.throwIfAborted();
    let directory;
    try {
      directory = await opendir(path, { bufferSize: 16 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for await (const entry of directory) {
      signal.throwIfAborted();
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        yield* walk(child, scope);
      } else if (entry.isFile() && /\.jsonl(?:\.zst)?$/u.test(entry.name)) {
        batch.push({ path: child, scope });
        if (batch.length === 16) {
          yield batch;
          batch = [];
        }
      }
    }
  }
  yield* walk(join(home, "sessions"), "active");
  yield* walk(join(home, "archived_sessions"), "archived");
  if (batch.length) {
    yield batch;
  }
}
