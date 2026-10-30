import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { readJsonlWindow } from "#server/ingestion/reverseJsonl.ts";
import { qualifyRawRecord } from "#server/ingestion/rolloutIdentity.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";

import { fixtureRef } from "../../fixtures/history/nativeHistory.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("preserves actual LF/CRLF byte identities, unknown tail ordinals and split multibyte records", async () => {
  const root = await mkdtemp(join(tmpdir(), "reverse-jsonl-"));
  roots.push(root);
  const path = join(root, "source.jsonl");
  const first = '{"type":"session_meta","payload":{"id":"stable"}}\r\n';
  const second = '{"type":"event_msg","payload":{"type":"user_message","message":"é🦊"}}\n';
  const third = '{"type":"event_msg","payload":{"type":"agent_message","message":"答"}}\r\n';
  await writeFile(path, first + second + third + '{"unfinished":');
  const store = new RolloutStore({ cacheDirectory: join(root, "cache") });
  const lease = await store.open(fixtureRef(path));
  const result = await readJsonlWindow(lease, {
    endExclusive: lease.size,
    maxBytes: 4096,
    maxRecords: 1,
    blockBytes: 7,
  });
  expect(result.records).toHaveLength(1);
  expect(result.records.at(0)!).toMatchObject({
    byteStart: Buffer.byteLength(first + second),
    byteEnd: Buffer.byteLength(first + second + third),
    raw: third.trim(),
    rangeSha256: createHash("sha256").update(Buffer.from(third)).digest("hex"),
  });
  expect(result.records.at(0)!.ordinal).toBeUndefined();
  expect(result.unfinishedFinalRecord).toBe(true);
  const all = await readJsonlWindow(lease, {
    endExclusive: lease.size,
    maxBytes: 4096,
    maxRecords: 10,
    blockBytes: 7,
    ordinalOrigin: 48,
  });
  expect(all.records.map((record) => record.ordinal)).toEqual([48, 49, 50]);
  expect(all.records.at(0)!.rangeSha256).toBe(
    createHash("sha256").update(Buffer.from(first)).digest("hex"),
  );
  expect(qualifyRawRecord(all.records.at(1)!, fixtureRef(path)).identity).toEqual({
    codexHomeId: "home",
    physicalRolloutId: "physical",
    ordinal: 49,
    decodedByteStart: Buffer.byteLength(first),
    decodedByteEnd: Buffer.byteLength(first + second),
    rangeSha256: createHash("sha256").update(Buffer.from(second)).digest("hex"),
    correlationKeys: [],
  });
  await lease.close();
  await store.close();
});
