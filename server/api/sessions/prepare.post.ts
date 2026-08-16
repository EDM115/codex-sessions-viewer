import { defineEventHandler, readValidatedBody } from "h3";

import { useLiveViewerRuntime } from "../../live/requestContext.ts";
import { assertSameOriginMutation, validatePreparationBody } from "../_validation.ts";

export default defineEventHandler(async (event) => {
  assertSameOriginMutation(event);
  const body = await readValidatedBody(event, validatePreparationBody);
  return useLiveViewerRuntime(event).repository.prepareSessions(body.ids);
});
