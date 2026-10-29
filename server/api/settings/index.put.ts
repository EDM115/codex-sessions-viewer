import { assertSameOriginMutation } from "#server/api/_validation.ts";
import { useLiveViewerRuntime } from "#server/live/requestContext.ts";
import { serverViewerSettingsSchema } from "#shared/types/settings.ts";

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
