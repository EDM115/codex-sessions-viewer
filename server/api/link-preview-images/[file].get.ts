import { join } from "node:path";

import { sendCachedContent } from "#server/api/_content.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";
import { linkPreviewSchema } from "#shared/types/linkPreview.ts";

export default defineEventHandler(async (event) => {
  const file = getRouterParam(event, "file") ?? "";
  if (!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/u.test(file)) {
    throw createError({ statusCode: 404, statusMessage: "Preview image not found" });
  }
  const runtime = useLiveViewerRuntime(event);
  const row = runtime.database
    .prepare(
      "SELECT payload_json FROM website_previews WHERE json_extract(payload_json,'$.image.sha256') = ? LIMIT 1",
    )
    .get(file.slice(0, 64));
  const parsed =
    typeof row?.["payload_json"] === "string"
      ? linkPreviewSchema.safeParse(JSON.parse(row["payload_json"]))
      : null;
  const image = parsed?.success ? parsed.data.image : null;
  if (!image || !image.url.endsWith(`/${file}`)) {
    throw createError({ statusCode: 404, statusMessage: "Preview image not found" });
  }
  const root = join(runtime.cacheDir, "previews");
  return sendCachedContent(
    event,
    {
      path: join(root, file),
      mimeType: image.mimeType,
      byteSize: image.byteSize,
      sha256: image.sha256,
    },
    root,
  );
});
