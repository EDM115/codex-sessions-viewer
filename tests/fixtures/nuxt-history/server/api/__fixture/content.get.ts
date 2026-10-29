import { sendCachedContent } from "#server/api/_content.ts";

import { fixtureContent } from "../../utils/fixtureState.ts";

export default defineEventHandler(async (event) => {
  const selection = fixtureContent();
  if (!selection) {
    throw createError({ statusCode: 404 });
  }
  return sendCachedContent(event, selection.file, selection.root);
});
