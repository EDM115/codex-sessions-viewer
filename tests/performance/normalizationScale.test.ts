import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type { JsonlRecord } from "../../server/ingestion/jsonlStream.ts";
import { normalizeSession } from "../../server/normalization/normalizeSession.ts";

function scaleRecords(turnCount: number): JsonlRecord[] {
  const values: JsonlRecord["value"][] = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "77777777-7777-4777-8777-777777777777" },
    },
  ];
  for (let index = 0; index < turnCount; index += 1) {
    values.push(
      {
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: {
            model: `gpt-${index % 5}`,
            reasoning_effort: index % 2 === 0 ? "high" : "medium",
          },
        },
      },
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: `turn-${index}` },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: `Prompt ${index}` },
      },
      {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: `turn-${index}` },
      },
    );
  }
  return values.map((value, index) => ({
    lineNumber: index + 1,
    byteStart: index * 100,
    byteEnd: (index + 1) * 100,
    raw: JSON.stringify(value),
    value,
  }));
}

function medianNormalizationMs(records: readonly JsonlRecord[], expectedTurnCount: number): number {
  const durations: number[] = [];
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const startedAt = performance.now();
    const result = normalizeSession({
      records,
      sourcePath: "C:/fixtures/normalization-scale.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
    });
    durations.push(performance.now() - startedAt);
    expect(result.session?.turns).toHaveLength(expectedTurnCount);
    expect(result.session?.turns.at(-1)).toMatchObject({
      id: `turn-${expectedTurnCount - 1}`,
      userMessage: { sourceMarkdown: `Prompt ${expectedTurnCount - 1}` },
      models: ["gpt-4"],
      reasoningEfforts: ["medium"],
    });
  }
  return durations.toSorted((left, right) => left - right)[1]!;
}

describe("normalization scale", () => {
  it("keeps a doubled settings-heavy workload below near-quadratic growth", () => {
    const smaller = scaleRecords(800);
    const larger = scaleRecords(1_600);
    medianNormalizationMs(smaller, 800);
    medianNormalizationMs(larger, 1_600);
    const smallerMedianMs = medianNormalizationMs(smaller, 800);
    const largerMedianMs = medianNormalizationMs(larger, 1_600);

    expect(
      largerMedianMs,
      `${smallerMedianMs.toFixed(1)} ms -> ${largerMedianMs.toFixed(1)} ms`,
    ).toBeLessThan(smallerMedianMs * 3);
    expect(largerMedianMs).toBeLessThan(5_000);
  }, 20_000);
});
