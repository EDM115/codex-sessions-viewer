import { assertSameOriginMutation, validatePreparationBody } from "#server/api/_validation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  assertSameOriginMutation(event);
  const body = await readValidatedBody(event, validatePreparationBody);
  return useLiveViewerRuntime(event).repository.prepareSessions(body.ids);
});
