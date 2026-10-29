import { assetId, notFound } from "#server/api/_validation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  const runtime = useLiveViewerRuntime(event);
  const id = await assetId(event);
  try {
    return await runtime.repository.resolveAsset(id);
  } catch {
    return notFound("Asset not found");
  }
});
