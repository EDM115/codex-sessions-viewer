import { defineEventHandler, readValidatedBody } from "h3";

import { serverViewerSettingsSchema } from "../../../shared/types/settings.ts";
import { useLiveViewerRuntime } from "../../live/requestContext.ts";
import { assertSameOriginMutation } from "../_validation.ts";

export default defineEventHandler(async (event) => {
  assertSameOriginMutation(event);
  const settings = await readValidatedBody(event, (value) => {
    const parsed = serverViewerSettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : false;
  });
  const runtime = useLiveViewerRuntime(event);
  await runtime.updateSettings(settings);
  return { server: runtime.settings, diagnostics: runtime.diagnostics };
});
