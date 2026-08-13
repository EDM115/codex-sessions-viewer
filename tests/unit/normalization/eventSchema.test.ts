import { describe, expect, it } from "vitest";

import type { JsonlRecord } from "../../../server/ingestion/jsonlStream.ts";
import {
  isUnknownCodexEvent,
  parseCodexEvent,
  sessionMetaPayloadSchema,
} from "../../../server/normalization/eventSchema.ts";
import {
  createUnknownActivity,
  sanitizeUnknownPayload,
} from "../../../server/normalization/unknownEvents.ts";

function record(value: JsonlRecord["value"], lineNumber = 1): JsonlRecord {
  return {
    lineNumber,
    byteStart: (lineNumber - 1) * 100,
    byteEnd: lineNumber * 100,
    raw: JSON.stringify(value),
    value,
  };
}

describe("Codex event schema", () => {
  it("accepts legacy and modern session identity shapes without requiring unrelated metadata", () => {
    const legacy = sessionMetaPayloadSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: "C:\\work",
    });
    const modern = sessionMetaPayloadSchema.parse({
      id: "22222222-2222-4222-8222-222222222222",
      session_id: "33333333-3333-4333-8333-333333333333",
      parent_thread_id: "44444444-4444-4444-8444-444444444444",
      timestamp: "2026-01-01T11:00:00.000Z",
      cwd: "C:\\work",
    });
    const sessionIdOnly = sessionMetaPayloadSchema.parse({
      session_id: "55555555-5555-4555-8555-555555555555",
      cwd: "C:\\work",
    });

    expect(legacy.session_id).toBeUndefined();
    expect(modern).toMatchObject({
      session_id: "33333333-3333-4333-8333-333333333333",
      parent_thread_id: "44444444-4444-4444-8444-444444444444",
    });
    expect(sessionIdOnly).toMatchObject({
      session_id: "55555555-5555-4555-8555-555555555555",
    });
    expect(() => sessionMetaPayloadSchema.parse({ cwd: "C:\\work" })).toThrow(
      "Session metadata requires id or session_id.",
    );
  });

  it("validates the envelope while retaining unknown fields and source location", () => {
    const parsed = parseCodexEvent(
      record({
        timestamp: "2026-01-01T10:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1", future_field: true },
        future_top_level: "preserved",
      }),
    );

    expect(parsed).toEqual({
      success: true,
      event: expect.objectContaining({
        id: "raw-0",
        type: "event_msg",
        payloadType: "task_started",
        timestamp: "2026-01-01T10:00:00.000Z",
        lineNumber: 1,
        raw: expect.objectContaining({ future_top_level: "preserved" }),
      }),
    });
  });

  it("rejects non-object records and envelopes without a non-empty type", () => {
    expect(parseCodexEvent(record("valid JSON, invalid event"))).toEqual({
      success: false,
      reason: "invalid-event-envelope",
      lineNumber: 1,
    });
    expect(parseCodexEvent(record({ type: "", payload: {} }, 2))).toEqual({
      success: false,
      reason: "invalid-event-envelope",
      lineNumber: 2,
    });
  });

  it("classifies both unknown top-level and unknown payload event families", () => {
    const unknownTop = parseCodexEvent(record({ type: "future_top", payload: { value: 1 } }));
    const unknownPayload = parseCodexEvent(
      record({ type: "event_msg", payload: { type: "future_payload", value: 1 } }, 2),
    );

    expect(unknownTop.success && isUnknownCodexEvent(unknownTop.event)).toBe(true);
    expect(unknownPayload.success && isUnknownCodexEvent(unknownPayload.event)).toBe(true);
  });
});

describe("unknown event preservation", () => {
  it("redacts credential and opaque-encryption fields recursively without dropping ordinary data", () => {
    const sanitized = sanitizeUnknownPayload(
      JSON.parse(
        '{"token_count":12,"tokens_used":34,"access_token":"fake-access-token","nested":{"Authorization":"Bearer fake","apiKey":"fake-api-key","encrypted_content":"opaque-ciphertext","safe":"visible"},"list":[{"password":"fake-password","value":7}],"__proto__":{"polluted":true}}',
      ),
    );

    expect(sanitized).toEqual({
      token_count: 12,
      tokens_used: 34,
      access_token: "[redacted]",
      nested: {
        Authorization: "[redacted]",
        apiKey: "[redacted]",
        encrypted_content: "[redacted]",
        safe: "visible",
      },
      list: [{ password: "[redacted]", value: 7 }],
    });
    if (sanitized === null || typeof sanitized !== "object") {
      throw new Error("Expected a sanitized object");
    }
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(false);
  });

  it("creates an inspector-safe UnknownActivity for a future payload type", () => {
    const parsed = parseCodexEvent(
      record({
        timestamp: "2026-01-01T10:00:00.000Z",
        type: "event_msg",
        payload: { type: "future_payload", secret_blob: "fake-secret", value: 7 },
      }),
    );
    if (!parsed.success) {
      throw new Error("Expected the fixture event to parse");
    }

    const activity = createUnknownActivity(parsed.event, "turn-1");

    expect(activity).toEqual({
      id: "activity-raw-0",
      turnId: "turn-1",
      createdAt: "2026-01-01T10:00:00.000Z",
      rawEventIds: ["raw-0"],
      kind: "unknown",
      eventType: "event_msg:future_payload",
      payload: {
        timestamp: "2026-01-01T10:00:00.000Z",
        type: "event_msg",
        payload: { type: "future_payload", secret_blob: "[redacted]", value: 7 },
      },
    });
  });
});
