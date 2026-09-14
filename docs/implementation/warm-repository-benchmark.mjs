import { writeFileSync } from "node:fs";

import { createJiti } from "jiti";
const j = createJiti(process.cwd() + "/");
const { openCacheDatabase } = await j.import("./server/cache/database.ts");
const { replaceCachedSession, getCachedSession } = await j.import(
  "./server/cache/conversationStore.ts",
);
const { getCachedTurnChunk } = await j.import("./server/cache/repositoryStore.ts");
const { LiveReconciler } = await j.import("./server/live/reconciler.ts");
const { LiveConversationRepository } = await j.import("./server/live/repository.ts");
const { InvalidationBus } = await j.import("./server/live/invalidationBus.ts");
const { normalizedRolloutFixture, cachedSource } = await j.import(
  "./tests/fixtures/cache/normalized.ts",
);
const { representativeLargeSession } = await j.import("./tests/performance/fixtures.ts");
const fixture = await normalizedRolloutFixture({
  name: "modern.jsonl",
  sourcePath: "C:/fixtures/backend-benchmark.jsonl",
  scope: "active",
  revision: "sha256:benchmark",
});
const session = representativeLargeSession(fixture);
const database = openCacheDatabase(":memory:");
replaceCachedSession(database, { session, diagnostics: [], source: cachedSource(session) });
const bus = new InvalidationBus();
const reconciler = new LiveReconciler({
  database,
  bus,
  codexHome: "C:/fixtures",
  cacheDir: process.cwd() + "/.nuxt/backend-benchmark",
  fetchFavicons: false,
});
const repository = new LiveConversationRepository(database, bus, reconciler);
const query = { targetTurnId: "scale-turn-487", limit: 20 };
await repository.getTurns(session.summary.id, query);
async function median(op) {
  const values = [];
  for (let n = 0; n < 20; n++) {
    const start = performance.now();
    // Separate samples measure latency without concurrent requests or shared warmup.
    // eslint-disable-next-line no-await-in-loop
    await op();
    values.push(performance.now() - start);
  }
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[9] + sorted[10]) / 2;
}
const results = {
  node: process.version,
  turns: session.turns.length,
  requestedTurns: 20,
  samples: 20,
  rawEvents: session.rawEvents.length,
  warmDirectMedianMs: await median(() => getCachedTurnChunk(database, session.summary.id, query)),
  warmRealRepositoryMedianMs: await median(() => repository.getTurns(session.summary.id, query)),
  fullReconstructionMedianMs: await median(() => getCachedSession(database, session.summary.id)),
  note: "Synthetic fixture diagnostic. No real archive or HTTP/browser latency measured.",
};
writeFileSync(
  new URL("./warm-repository-benchmark.json", import.meta.url),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(results);
await reconciler.close();
database.close();
