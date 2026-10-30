import type { DatabaseSync } from "node:sqlite";

import { LinkPreviewService, readPreviewImage } from "#server/content/linkPreviews.ts";
import { serializedJson, writeOutputFile } from "#server/export/outputFiles.ts";
import { canonicalWebsiteUrl, type LinkPreview } from "#shared/types/linkPreview.ts";

export async function publishLinkPreviews(
  database: DatabaseSync,
  options: {
    cacheRoot: string;
    generatedRoot: string;
    publicRoot?: string | undefined;
    urls: ReadonlySet<string>;
  },
) {
  const service = new LinkPreviewService(database, options.cacheRoot, { enabled: false });
  const previews: LinkPreview[] = [];
  try {
    // oxlint-disable no-await-in-loop -- Publish only referenced, verified saved enrichment in deterministic URL order
    for (const input of [...options.urls].toSorted()) {
      let url: string;
      try {
        url = canonicalWebsiteUrl(input);
      } catch {
        continue;
      }
      const saved = await service.cached(url);
      if (!saved) {
        continue;
      }
      if (saved.image) {
        const bytes = await readPreviewImage(options.cacheRoot, saved.image);
        if (bytes) {
          const name = saved.image.url.slice(saved.image.url.lastIndexOf("/") + 1);
          await writeOutputFile(options.generatedRoot, ["previews", name], bytes);
          if (options.publicRoot) {
            await writeOutputFile(options.publicRoot, ["previews", name], bytes);
          }
          saved.image = { ...saved.image, url: `/previews/${name}` };
        } else {
          saved.image = null;
        }
      }
      previews.push(saved);
    }
    const payload = serializedJson({ version: 1, previews });
    await writeOutputFile(options.generatedRoot, ["payloads", "link-previews.json"], payload);
    if (options.publicRoot) {
      await writeOutputFile(options.publicRoot, ["payloads", "link-previews.json"], payload);
    }
    // oxlint-enable no-await-in-loop
  } finally {
    await service.close();
  }
  return previews.length;
}
