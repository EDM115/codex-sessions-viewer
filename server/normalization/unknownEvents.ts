import type { JsonObject, JsonValue, UnknownActivity } from "../../shared/types/conversation.ts";
import { codexEventType, type CodexEvent } from "./eventSchema.ts";

const omittedKeys = new Set(["__proto__", "constructor", "prototype"]);
const redactedKeys = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "clientsecret",
  "cookie",
  "encryptedcontent",
  "idtoken",
  "password",
  "passwd",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "secretblob",
  "sessiontoken",
  "setcookie",
  "token",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z\d]/g, "");
}

export function sanitizeUnknownPayload(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknownPayload(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const sanitized: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (omittedKeys.has(key.toLowerCase()) || omittedKeys.has(normalized)) {
      continue;
    }
    sanitized[key] = redactedKeys.has(normalized) ? "[redacted]" : sanitizeUnknownPayload(item);
  }
  return sanitized;
}

export function createUnknownActivity(event: CodexEvent, turnId: string): UnknownActivity {
  return {
    id: `activity-${event.id}`,
    turnId,
    createdAt: event.timestamp,
    rawEventIds: [event.id],
    kind: "unknown",
    eventType: codexEventType(event),
    payload: sanitizeUnknownPayload(event.raw),
  };
}
