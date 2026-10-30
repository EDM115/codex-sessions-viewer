import type { HistoryAttachment, HistoryItem } from "#shared/types/history.ts";

/** These are observed references, file paths never establish resolver authority */
export function historyItemAttachments(item: HistoryItem): HistoryAttachment[] {
  if (item.type === "imageGeneration") {
    const result = item.result;
    const source = result
      ? /^(?:data:|https?:|sediment:)/u.test(result)
        ? result
        : `data:image/png;base64,${result}`
      : (item.savedPath ?? (item.fileId ? `sediment:${item.fileId}` : ""));
    return [{ mediaType: "image", source: boundedSource(source) }];
  }
  if (item.type !== "userMessage") {
    return [];
  }
  return item.content.flatMap((part): HistoryAttachment[] => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      return [];
    }
    const source =
      typeof part["url"] === "string"
        ? part["url"]
        : typeof part["path"] === "string"
          ? part["path"]
          : typeof part["fileId"] === "string"
            ? `sediment:${part["fileId"]}`
            : null;
    if (source === null) {
      return [];
    }
    if (part["type"] === "image" || part["type"] === "localImage") {
      return [{ mediaType: "image", source: boundedSource(source) }];
    }
    if (part["type"] === "audio" || part["type"] === "localAudio") {
      return [{ mediaType: "audio", source: boundedSource(source) }];
    }
    return [];
  });
}

function boundedSource(source: string): string {
  return source.length > 5 * 1024 * 1024
    ? "unavailable:recorded-reference-exceeds-presentation-limit"
    : source;
}
