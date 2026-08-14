import { defineEventHandler } from "h3";

import { useLiveViewerRuntime } from "../../live/requestContext.ts";
import { assetId, notFound } from "../_validation.ts";

export default defineEventHandler(async (event) => {
  const runtime = useLiveViewerRuntime(event);
  const id = await assetId(event);
  try {
    return await runtime.repository.resolveAsset(id);
  } catch {
    return notFound("Asset not found");
  }
});
