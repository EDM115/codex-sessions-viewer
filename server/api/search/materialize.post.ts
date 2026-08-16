import { defineEventHandler, readValidatedBody } from "h3";

import { useLiveViewerRuntime } from "../../live/requestContext.ts";
import { assertSameOriginMutation, validateDeepSearchBody } from "../_validation.ts";

export default defineEventHandler(async (event) => {
  assertSameOriginMutation(event);
  const query = await readValidatedBody(event, validateDeepSearchBody);
  return useLiveViewerRuntime(event).repository.startDeepSearch(query);
});
