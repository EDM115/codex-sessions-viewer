import { assertSameOriginMutation, validateDeepSearchBody } from "#server/api/_validation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler(async (event) => {
  assertSameOriginMutation(event);
  const query = await readValidatedBody(event, validateDeepSearchBody);
  return useLiveViewerRuntime(event).repository.startDeepSearch(query);
});
