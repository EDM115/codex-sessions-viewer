import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseRolloutFilename,
  qualifyRawRecord,
  rawRecordIdentity,
  sameObservedItem,
} from "../../../server/ingestion/rolloutIdentity.ts";
import {
  resolveRolloutLineage,
  readPlainRolloutLineage,
} from "../../../server/ingestion/rolloutLineage.ts";
import { selectSessionSources } from "../../../server/ingestion/selectSessionSources.ts";
import { readSessionMetaPrefix } from "../../../server/ingestion/sessionMetaPrefix.ts";
import {
  validateSourceGeneration,
  validateSourceRanges,
  SourceGenerationFence,
  completeDecodedGeneration,
} from "../../../server/ingestion/sourceGeneration.ts";
import { normalizeSession } from "../../../server/normalization/normalizeSession.ts";
import {
  sourceGenerationSchema,
  type RolloutRef,
  type JsonValue,
  type SourceGeneration,
} from "../../../shared/types/conversation.ts";

const stable = "11111111-1111-4111-8111-111111111111";
const physical = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const parent = join(process.cwd(), ".tmp", "task2-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "source-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function ref(id: string, overrides: Partial<RolloutRef> = {}): RolloutRef {
  return {
    codexHomeId: "home",
    stableThreadId: stable,
    physicalRolloutId: id,
    rootSessionId: "root",
    sourcePath: `${id}.jsonl`,
    representation: "plain-jsonl",
    historyBase: null,
    subagentHistoryStartOrdinal: null,
    ...overrides,
  };
}

describe("physical rollout identity and lineage", () => {
  it("keeps filename stable and physical IDs separate through compression", () => {
    expect(
      parseRolloutFilename(`rollout-2026-10-27T10-00-00-${stable}_${physical}.jsonl.zst`),
    ).toEqual({
      stableThreadId: stable,
      physicalRolloutId: physical,
      representation: "zstd-jsonl",
    });
    expect(
      parseRolloutFilename(`rollout-2026-10-27T10-00-00-${stable}.jsonl`)?.physicalRolloutId,
    ).toBe(stable);
    expect(parseRolloutFilename(`rollout-${stable}.json`)).toBeNull();
  });
  it("retains exact metadata references and separate topology edges", async () => {
    const path = join(await fixture(), "source.jsonl");
    await writeFile(
      path,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: stable,
          session_id: "different-root",
          parent_thread_id: "parent",
          forked_from_id: "fork",
          attached_thread: { thread_id: "attached" },
          forked_from_ordinal_exclusive: 4,
          history_base: { thread_id: physical, end_ordinal_exclusive: 8, end_byte_offset: 900 },
          subagent_history_start_ordinal: 10,
        },
      }) + "\n",
    );
    expect((await readSessionMetaPrefix(path, 4096)).meta).toMatchObject({
      id: stable,
      rootSessionId: "different-root",
      historyBase: { physicalRolloutId: physical, endOrdinalExclusive: 8, endByteOffset: 900 },
      subagentHistoryStartOrdinal: 10,
      forkedFromId: "fork",
      parentThreadId: "parent",
      attachedThread: { thread_id: "attached" },
    });
  });
  it("resolves physical bases oldest-first with exclusive bounds and child display starts", async () => {
    const base = ref("base", {
      stableThreadId: "parent",
      rootSessionId: "parent-root",
      representation: "zstd-jsonl",
      sourcePath: "archive/base.jsonl.zst",
    });
    const current = ref("current", {
      rootSessionId: "child-root",
      historyBase: { physicalRolloutId: "base", endOrdinalExclusive: 8, endByteOffset: 900 },
      subagentHistoryStartOrdinal: 10,
    });
    const result = await resolveRolloutLineage(current, {
      resolve: async (id) => (id === "base" ? base : null),
      validateBoundary: async (_source, bound) => bound.endByteOffset === 900,
    });
    expect(result.status).toBe("complete");
    expect(
      result.segments.map((segment) => [
        segment.ref.physicalRolloutId,
        segment.bodyStartOrdinal,
        segment.endOrdinalExclusive,
        segment.endByteOffset,
        segment.displayStartOrdinal,
      ]),
    ).toEqual([
      ["base", 1, 8, 900, 10],
      ["current", 9, null, null, 10],
    ]);
  });
  it("reports missing, cyclic and impossible base evidence without presenting complete history", async () => {
    const current = ref("current", {
      historyBase: { physicalRolloutId: "missing", endOrdinalExclusive: 2, endByteOffset: 20 },
    });
    expect((await resolveRolloutLineage(current, { resolve: async () => null })).status).toBe(
      "unresolved",
    );
    expect(
      (
        await resolveRolloutLineage(current, {
          resolve: async () => ({ ...current, physicalRolloutId: "missing" }),
          validateBoundary: async () => true,
        })
      ).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "lineage.cycle" }));
    expect(
      (
        await resolveRolloutLineage(current, {
          resolve: async () => ref("missing"),
          validateBoundary: async () => false,
        })
      ).status,
    ).toBe("unresolved");
  });
  it("qualifies identical offsets and ordinals by segment and verified record bytes, preserving provider IDs", () => {
    const record = {
      lineNumber: 1,
      byteStart: 0,
      byteEnd: 10,
      raw: "payload",
      value: { type: "event_msg", payload: { id: "provider" } },
    };
    const a = qualifyRawRecord(record, ref("a"));
    const b = qualifyRawRecord(record, ref("b"));
    expect(rawRecordIdentity(a)).not.toBe(rawRecordIdentity(b));
    expect(rawRecordIdentity(a)).toBe(rawRecordIdentity(qualifyRawRecord(record, ref("a"))));
    expect(rawRecordIdentity(a)).not.toBe(
      rawRecordIdentity(qualifyRawRecord({ ...record, raw: "changed" }, ref("a"))),
    );
    expect(a.identity?.correlationKeys).toEqual(["item:provider"]);
    expect(
      sameObservedItem(a.identity!, {
        codexHomeId: "home",
        physicalRolloutId: "a",
        correlationKeys: ["item:provider"],
      }),
    ).toBe(true);
    expect(
      sameObservedItem(a.identity!, {
        codexHomeId: "home",
        physicalRolloutId: "b",
        correlationKeys: ["item:provider"],
      }),
    ).toBe(false);
    expect(
      sameObservedItem(a.identity!, {
        codexHomeId: "home",
        physicalRolloutId: "a",
        correlationKeys: ["call:provider"],
      }),
    ).toBe(false);
  });
  it("orders a turn across physical segments using lineage order rather than repeated offsets", () => {
    const values: JsonValue[] = [
      { type: "session_meta", payload: { id: stable } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "shared" } },
      { type: "event_msg", payload: { type: "user_message", message: "prompt" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "before revert" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "reasoning", summary: [{ type: "summary_text", text: "after revert" }] },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "final reply" }],
        },
      },
    ];
    const records = values.map((value, logicalOrder) =>
      qualifyRawRecord(
        {
          value,
          raw: JSON.stringify(value),
          logicalOrder,
          lineNumber: logicalOrder + 1,
          byteStart: logicalOrder < 4 ? logicalOrder * 1000 : (logicalOrder - 4) * 100,
          byteEnd: logicalOrder < 4 ? logicalOrder * 1000 + 100 : (logicalOrder - 4) * 100 + 100,
        },
        ref(logicalOrder < 4 ? "base" : "current"),
      ),
    );
    const session = normalizeSession({
      records,
      sourcePath: "current.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
    }).session!;
    const turn = session.turns[0];
    if (turn === undefined) {
      throw new Error("Expected a turn spanning both physical segments");
    }
    const labels = new Map([
      ...turn.assistantMessages.map((message) => [message.id, message.sourceMarkdown] as const),
      ...turn.activities
        .filter((activity) => activity.kind === "reasoning")
        .map((activity) => [activity.id, "after revert"] as const),
    ]);
    expect(
      turn.entryOrder?.filter((entry) => labels.has(entry.id)).map((entry) => labels.get(entry.id)),
    ).toEqual(["before revert", "after revert", "final reply"]);
    expect(session.rawEvents[4]?.identity?.decodedByteStart).toBe(0);
  });
  it("keeps all physical segments and prefers a valid plain sibling despite compressed mtime", async () => {
    const root = await fixture();
    const base = join(root, `rollout-2026-10-27T10-00-00-${stable}.jsonl`);
    const child = join(root, `rollout-2026-10-27T10-00-00-${stable}_${physical}.jsonl`);
    const compressed = `${child}.zst`;
    await writeFile(base, JSON.stringify({ type: "session_meta", payload: { id: stable } }) + "\n");
    await writeFile(
      child,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: stable,
          history_base: { thread_id: stable, end_ordinal_exclusive: 1, end_byte_offset: 100 },
        },
      }) + "\n",
    );
    await writeFile(compressed, "opaque compressed bytes");
    const result = await selectSessionSources(
      [base, child, compressed].map((path) => ({ path, scope: "active" as const })),
    );
    expect(
      result.physicalSegments
        .map((segment) => segment.source.path)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([base, child].toSorted((a, b) => a.localeCompare(b)));
    expect(result.selected.map((segment) => segment.source.path)).toEqual([child]);
    const overridden = await selectSessionSources(
      [base, child].map((path) => ({ path, scope: "active" as const })),
      { currentRolloutPaths: new Map([[stable, base]]) },
    );
    expect(overridden.selected.map((segment) => segment.source.path)).toEqual([base]);
  });
  it("materializes exact bounded plain ancestry while retaining inherited raw evidence outside child display", async () => {
    const root = await fixture();
    const basePath = join(root, "base.jsonl");
    const currentPath = join(root, "current.jsonl");
    const baseText = [
      { type: "session_meta", payload: { id: "parent", session_id: "root-parent" } },
      { type: "event_msg", payload: { type: "user_message", message: "inherited" } },
    ]
      .map((value) => JSON.stringify(value) + "\n")
      .join("");
    await writeFile(
      basePath,
      baseText +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "excluded parent suffix" },
        }) +
        "\n",
    );
    const current = ref("current", {
      sourcePath: currentPath,
      rootSessionId: "root-child",
      historyBase: {
        physicalRolloutId: "base",
        endOrdinalExclusive: 2,
        endByteOffset: Buffer.byteLength(baseText),
      },
      subagentHistoryStartOrdinal: 3,
    });
    await writeFile(
      currentPath,
      [
        {
          type: "session_meta",
          payload: {
            id: stable,
            session_id: "root-child",
            history_base: {
              thread_id: "base",
              end_ordinal_exclusive: 2,
              end_byte_offset: Buffer.byteLength(baseText),
            },
            subagent_history_start_ordinal: 3,
          },
        },
        { type: "event_msg", payload: { type: "user_message", message: "child prompt" } },
      ]
        .map((value) => JSON.stringify(value) + "\n")
        .join(""),
    );
    const materialized = await readPlainRolloutLineage(current, {
      resolve: async () =>
        ref("base", {
          sourcePath: basePath,
          stableThreadId: "parent",
          rootSessionId: "root-parent",
        }),
    });
    const session = normalizeSession({
      records: materialized.records,
      sourcePath: currentPath,
      rolloutRef: current,
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
    }).session!;
    expect(session.summary.id).toBe(stable);
    expect(session.summary.preview).toBe("child prompt");
    expect(JSON.stringify(session.turns)).not.toContain("inherited");
    expect(JSON.stringify(session.rawEvents)).toContain("inherited");
    expect(JSON.stringify(session.rawEvents)).not.toContain("excluded parent suffix");
    expect(materialized.dependencies).toHaveLength(1);
  });
});

describe("source generations", () => {
  it("issues new plain history incarnations for return-to-earlier-content cycles across restarts", async () => {
    const path = join(await fixture(), "source.jsonl");
    const source = ref("source", { sourcePath: path });
    const persisted = (generation: SourceGeneration) =>
      sourceGenerationSchema.parse(JSON.parse(JSON.stringify(generation)));
    await writeFile(path, "A\n");
    const a = (await validateSourceGeneration(source, null)).generation;
    await writeFile(path, "A\nB\n");
    const ab = (await validateSourceGeneration(source, persisted(a))).generation;
    expect(ab.semanticEpoch).toBe(a.semanticEpoch);
    await writeFile(path, "A\n");
    const truncated = (await validateSourceGeneration(source, persisted(ab))).generation;
    expect(truncated.semanticEpoch).not.toBe(ab.semanticEpoch);
    expect(truncated.decodedSha256).toBe(a.decodedSha256);
    await writeFile(path, "C\n");
    const c = (await validateSourceGeneration(source, persisted(truncated))).generation;
    await writeFile(path, "A\n");
    const restored = (await validateSourceGeneration(source, persisted(c))).generation;
    expect(
      new Set([a.semanticEpoch, truncated.semanticEpoch, c.semanticEpoch, restored.semanticEpoch])
        .size,
    ).toBe(4);
    expect(
      (await validateSourceGeneration(source, persisted(restored))).generation.semanticEpoch,
    ).toBe(restored.semanticEpoch);
  });
  it("issues new decoded history incarnations on compressed truncation and replacement cycles", async () => {
    const path = join(await fixture(), "source.jsonl.zst");
    const source = ref("source", { sourcePath: path, representation: "zstd-jsonl" });
    async function complete(text: string, previous: SourceGeneration | null, prefix?: string) {
      await writeFile(path, zstdCompressSync(text));
      const restarted =
        previous === null
          ? null
          : sourceGenerationSchema.parse(JSON.parse(JSON.stringify(previous)));
      const encoded = (
        await validateSourceGeneration(source, restarted, undefined, {
          decoderVersion: "test-zstd",
        })
      ).generation;
      return completeDecodedGeneration(
        encoded,
        {
          encodedSha256: encoded.encodedSha256!,
          decodedSha256: digest(text),
          decodedSize: Buffer.byteLength(text),
          decoderVersion: "test-zstd",
          ...(prefix === undefined ? {} : { decodedPrefixSha256: digest(prefix) }),
        },
        restarted,
      );
    }
    const a = await complete("A\n", null);
    const ab = await complete("A\nB\n", a, "A\n");
    expect(ab.semanticEpoch).toBe(a.semanticEpoch);
    const truncated = await complete("A\n", ab);
    expect(truncated.semanticEpoch).not.toBe(ab.semanticEpoch);
    const c = await complete("C\n", truncated);
    const restored = await complete("A\n", c);
    expect(
      new Set([a.semanticEpoch, truncated.semanticEpoch, c.semanticEpoch, restored.semanticEpoch])
        .size,
    ).toBe(4);
    expect((await complete("A\n", restored)).semanticEpoch).toBe(restored.semanticEpoch);
  });
  it("preserves the semantic epoch on verified appends and changes it on truncation or replacement", async () => {
    const path = join(await fixture(), "source.jsonl");
    const source = ref("source", { sourcePath: path });
    await writeFile(path, "first\n");
    const a = await validateSourceGeneration(source, null);
    await writeFile(path, "first\nsecond\n");
    const b = await validateSourceGeneration(source, a.generation);
    expect(a.generation.semanticEpoch).toEqual(expect.any(String));
    expect(b.generation.semanticEpoch).toBe(a.generation.semanticEpoch);
    await writeFile(path, "other\nsecond\n");
    const replaced = await validateSourceGeneration(source, b.generation);
    expect(replaced.generation.semanticEpoch).not.toBe(b.generation.semanticEpoch);
    await writeFile(path, "other\n");
    const truncated = await validateSourceGeneration(source, replaced.generation);
    expect(truncated.generation.semanticEpoch).not.toBe(replaced.generation.semanticEpoch);
  });
  it("detects equal-size equal-mtime replacement and preserves only verified range claims", async () => {
    const path = join(await fixture(), "source.jsonl");
    const date = new Date("2026-01-01T00:00:00Z");
    await writeFile(path, "one\ntwo\n");
    await utimes(path, date, date);
    const source = ref("source", { sourcePath: path });
    const first = await validateSourceGeneration(source, null);
    await writeFile(path, "ONE\ntwo\n");
    await utimes(path, date, date);
    const second = await validateSourceGeneration(source, first.generation);
    expect(second.generation.encodedSha256).not.toBe(first.generation.encodedSha256);
    expect(second.reuse).toBe("none");
    const selected = await validateSourceRanges(
      source,
      [{ start: 4, endExclusive: 8 }],
      first.generation,
    );
    expect(selected.generation).toMatchObject({
      validationScope: "selected-range",
      decodedSha256: null,
      encodedSha256: null,
      verifiedDecodedRanges: [{ start: 4, endExclusive: 8, sha256: digest("two\n") }],
    });
  });
  it("does not reuse decoded content after a same-path compressed lifecycle and preserves equal decoded semantics", async () => {
    const path = join(await fixture(), "source.jsonl.zst");
    const source = ref("source", { sourcePath: path, representation: "zstd-jsonl" });
    await writeFile(path, "compressed-A");
    const a = await validateSourceGeneration(source, null);
    const decoded = completeDecodedGeneration(a.generation, {
      encodedSha256: a.generation.encodedSha256!,
      decodedSha256: digest("A"),
      decodedSize: 1,
      decoderVersion: "test-decoder",
    });
    expect(
      (
        await validateSourceGeneration(source, decoded, undefined, {
          decoderVersion: "test-decoder",
        })
      ).reuse,
    ).toBe("decoded");
    await writeFile(path, "compressed-B");
    const b = await validateSourceGeneration(source, decoded);
    expect(b.generation.decodedSha256).toBeNull();
    expect(b.reuse).toBe("none");
    const recompressed = completeDecodedGeneration(b.generation, {
      encodedSha256: b.generation.encodedSha256!,
      decodedSha256: digest("A"),
      decodedSize: 1,
      decoderVersion: "test-decoder",
    });
    expect(recompressed.decodedSha256).toBe(decoded.decodedSha256);
  });
  it("validates the actual plain-compressed-resume-compressed lifecycle at the old encoded path", async () => {
    const root = await fixture();
    const path = join(root, "source.jsonl");
    const compressedPath = `${path}.zst`;
    const a = '{"value":"A"}\n';
    const b = a + '{"value":"B"}\n';
    await writeFile(path, a);
    const plain = ref("source", { sourcePath: path });
    const encoded = ref("source", { sourcePath: compressedPath, representation: "zstd-jsonl" });
    const initial = await validateSourceGeneration(plain, null);
    await writeFile(compressedPath, zstdCompressSync(a));
    await rm(path);
    const cached = await validateSourceGeneration(encoded, initial.generation);
    const decodedA = completeDecodedGeneration(cached.generation, {
      encodedSha256: cached.generation.encodedSha256!,
      decodedSha256: digest(a),
      decodedSize: Buffer.byteLength(a),
      decoderVersion: "test-zstd",
    });
    await writeFile(path, b);
    const resumed = await validateSourceGeneration(plain, decodedA);
    expect(resumed.generation.decodedSha256).toBe(digest(b));
    const temporary = join(root, "staging.jsonl.zst");
    await writeFile(temporary, zstdCompressSync(b));
    await rename(temporary, compressedPath);
    await rm(path);
    const restarted = await validateSourceGeneration(encoded, decodedA, undefined, {
      decoderVersion: "test-zstd",
    });
    expect(restarted.reuse).toBe("none");
    expect(restarted.generation.decodedSha256).toBeNull();
    expect(restarted.generation.encodedSha256).not.toBe(decodedA.encodedSha256);
  });
  it("fences late workers and refuses mismatched decoder input evidence", async () => {
    const fence = new SourceGenerationFence();
    const a = fence.begin("source");
    const b = fence.begin("source");
    expect(fence.isCurrent("source", a)).toBe(false);
    expect(fence.isCurrent("source", b)).toBe(true);
    const path = join(await fixture(), "source.jsonl");
    await writeFile(path, "x\n");
    const generation = (await validateSourceGeneration(ref("source", { sourcePath: path }), null))
      .generation;
    expect(() =>
      completeDecodedGeneration(generation, {
        encodedSha256: digest("wrong"),
        decodedSha256: digest("x"),
        decodedSize: 1,
        decoderVersion: "test",
      }),
    ).toThrow("Decoded output does not match the validated encoded generation");
  });
});
