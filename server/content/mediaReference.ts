import { createHash } from "node:crypto";

import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_REFERENCE_PREVIEW_LENGTH,
  type MediaReference,
  type MediaReferenceProvenance,
  type MediaActivity,
} from "#shared/types/conversation.ts";

function mediaReferenceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function invalidMediaReference(
  value: string | null,
  reason: Extract<MediaReference, { kind: "invalid" }>["reason"],
): Exclude<MediaReference, { kind: "asset" }> {
  return {
    kind: "invalid",
    reason,
    preview: value?.slice(0, MAX_MEDIA_REFERENCE_PREVIEW_LENGTH) ?? "",
    sourceHash: value === null ? null : mediaReferenceHash(value),
  };
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(value);
}

function percentDecodedSize(payload: string): number | null {
  let size = 0;
  for (let index = 0; index < payload.length;) {
    if (payload[index] === "%") {
      if (!/^[\da-f]{2}$/iu.test(payload.slice(index + 1, index + 3))) {
        return null;
      }
      size += 1;
      index += 3;
    } else {
      const codePoint = payload.codePointAt(index);
      if (codePoint === undefined) {
        return null;
      }
      const character = String.fromCodePoint(codePoint);
      size += Buffer.byteLength(character);
      index += character.length;
    }
    if (size > MAX_MEDIA_BYTES) {
      return size;
    }
  }
  return size;
}

function supportedDataMime(mediaType: MediaActivity["mediaType"], mimeType: string): boolean {
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("audio/")) {
    return false;
  }
  return mediaType === "file" || mimeType.startsWith(`${mediaType}/`);
}

function classifyDataReference(
  value: string,
  mediaType: MediaActivity["mediaType"],
): Exclude<MediaReference, { kind: "asset" }> {
  const separator = value.indexOf(",");
  if (separator < 6) {
    return invalidMediaReference(value, "malformed-data");
  }
  const header = value.slice(5, separator);
  const [declaredMimeType, ...parameters] = header.split(";");
  const mimeType = declaredMimeType?.trim().toLowerCase() ?? "";
  if (
    mimeType === "" ||
    !supportedDataMime(mediaType, mimeType) ||
    parameters.some((parameter) => parameter !== "base64" && !parameter.startsWith("charset=")) ||
    parameters.filter((parameter) => parameter === "base64").length > 1
  ) {
    return invalidMediaReference(value, "unsupported-media-type");
  }
  const payload = value.slice(separator + 1);
  const encoding = parameters.includes("base64") ? "base64" : "percent";
  let decodedSize: number | null;
  if (encoding === "base64") {
    if (payload.length % 4 !== 0 || !/^[a-z\d+/]*={0,2}$/iu.test(payload)) {
      return invalidMediaReference(value, "malformed-data");
    }
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    decodedSize = (payload.length / 4) * 3 - padding;
  } else {
    decodedSize = percentDecodedSize(payload);
    if (decodedSize === null) {
      return invalidMediaReference(value, "malformed-data");
    }
  }
  if (decodedSize > MAX_MEDIA_BYTES) {
    return invalidMediaReference(value, "oversized-data");
  }
  return {
    kind: "data",
    mimeType,
    encoding,
    payload,
    sourceHash: mediaReferenceHash(value),
  };
}

export function classifyMediaReference(
  value: string | null,
  mediaType: MediaActivity["mediaType"],
  provenance: MediaReferenceProvenance,
): Exclude<MediaReference, { kind: "asset" }> {
  if (value === null) {
    return invalidMediaReference(null, "missing");
  }
  const normalized = value.trim();
  if (normalized === "") {
    return invalidMediaReference(value, "empty");
  }
  if (normalized.startsWith("data:")) {
    return classifyDataReference(normalized, mediaType);
  }
  if (isAbsoluteLocalPath(normalized)) {
    return normalized.length <= 4_096
      ? { kind: "local-file", path: normalized, provenance }
      : invalidMediaReference(normalized, "malformed-path");
  }
  try {
    const url = new URL(normalized);
    if ((url.protocol === "http:" || url.protocol === "https:") && normalized.length <= 2_048) {
      return { kind: "remote", url: normalized };
    }
    return invalidMediaReference(normalized, "unsupported-scheme");
  } catch {
    return invalidMediaReference(normalized, "relative-path");
  }
}
