import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { storeReferencedMedia, type MediaStoreOptions } from "#server/content/extractMedia.ts";
import { classifyMediaReference } from "#server/content/mediaReference.ts";
import type { HistoryAttachment } from "#shared/types/history.ts";
import type { RichTextMediaNode } from "#shared/types/richText.ts";

/** Copy only selected references inside the existing configured roots, never infer a new root */
export async function prepareHistoryAttachments(
  database: DatabaseSync,
  attachments: readonly HistoryAttachment[],
  options: MediaStoreOptions,
): Promise<RichTextMediaNode[]> {
  const references = attachments.map(({ mediaType, source }) => ({
    mediaType,
    assetId: `asset-${createHash("sha256")
      .update(JSON.stringify([mediaType, source]))
      .digest("hex")}`,
    reference: classifyMediaReference(source, mediaType, "response-input"),
  }));
  await storeReferencedMedia(database, references, options);
  return references.map(({ assetId, mediaType, reference }, index) => ({
    type: "media",
    mediaType,
    source: reference.kind === "remote" ? "external" : "asset",
    assetId: reference.kind === "remote" ? null : assetId,
    originalSource:
      reference.kind === "data"
        ? `data:${reference.mimeType};sha256=${reference.sourceHash}`
        : attachments[index]!.source.slice(0, 4096),
    alt: mediaType === "image" ? "Recorded image" : "Recorded attachment",
    title: null,
  }));
}
