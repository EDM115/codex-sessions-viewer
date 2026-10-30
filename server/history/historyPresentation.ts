import { createHash } from "node:crypto";

import { parseRichText } from "#server/content/parseRichText.ts";
import {
  historyPresentationRequestSchema,
  type HistoryPresentationRequest,
  type HistoryPresentation,
  type HistoryAttachment,
} from "#shared/types/history.ts";
import type {
  EmbeddedMediaSource,
  RichTextDocument,
  RichTextMediaNode,
} from "#shared/types/richText.ts";

export interface HistoryPresentationMedia {
  onDocument?: (document: RichTextDocument) => void;
  cacheScope: string;
  storeEmbeddedMedia: (sources: readonly EmbeddedMediaSource[]) => Promise<void>;
  prepareAttachments?: (attachments: readonly HistoryAttachment[]) => Promise<RichTextMediaNode[]>;
}

const entries = new Map<
  string,
  { promise: Promise<HistoryPresentation>; subscribers: number; complete: boolean }
>();
/** This cache formats immutable supplied text, it neither reads sources nor changes history authority */
export function prepareHistoryPresentation(
  input: HistoryPresentationRequest,
  signal?: AbortSignal,
  media?: HistoryPresentationMedia,
): Promise<HistoryPresentation> {
  signal?.throwIfAborted();
  const query = historyPresentationRequestSchema.parse(input);
  const key = createHash("sha256")
    .update("history-presentation-v1")
    .update(JSON.stringify(query))
    .update(media?.cacheScope ?? "")
    .digest("hex");
  let entry = entries.get(key);
  if (!entry) {
    const promise = parseRichText(query.markdown).then(async ({ document, embeddedMedia }) => {
      if (media && embeddedMedia.length > 0) {
        await media.storeEmbeddedMedia(embeddedMedia);
      }
      if (query.attachments?.length) {
        const attachments = media?.prepareAttachments
          ? await media.prepareAttachments(query.attachments)
          : query.attachments.map(({ mediaType, source }): RichTextMediaNode => ({
              type: "media",
              mediaType,
              source: "missing",
              assetId: null,
              originalSource: source.startsWith("data:")
                ? "Retained inline attachment"
                : source.slice(0, 4096),
              alt: "Recorded attachment unavailable",
              title: null,
            }));
        document.children.push(...attachments);
      }
      return { ...query, body: document };
    });
    entry = { promise, subscribers: 0, complete: false };
    entries.set(key, entry);
    const active = entry;
    void promise.then(
      () => {
        active.complete = true;
        return undefined;
      },
      () => {
        if (entries.get(key) === active) {
          entries.delete(key);
        }
      },
    );
    if (entries.size > 64) {
      const oldest = [...entries].find(
        ([, candidate]) => candidate.complete && candidate.subscribers === 0,
      );
      if (oldest) {
        entries.delete(oldest[0]);
      }
    }
  }
  const active = entry;
  active.subscribers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const detach = () => {
      if (settled) {
        return false;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      active.subscribers -= 1;
      if (!active.complete && active.subscribers === 0 && entries.get(key) === active) {
        entries.delete(key);
      }
      return true;
    };
    const abort = () => {
      if (detach()) {
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    active.promise.then(
      (result) => {
        if (detach()) {
          try {
            media?.onDocument?.(result.body);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        }
        return undefined;
      },
      (error: unknown) => {
        if (detach()) {
          reject(error);
        }
      },
    );
  });
}
