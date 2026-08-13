import * as z from "zod";
import {
  disclosureDefaultSchema,
  viewerThemeSchema,
  type DisclosureDefault,
  type ViewerTheme,
} from "./conversation";

export interface ServerViewerSettings {
  codexHome: string;
  port: number;
  fetchFavicons: boolean;
}

export interface PresentationSettings {
  theme: ViewerTheme;
  toolCallsDefault: DisclosureDefault;
  reasoningDefault: DisclosureDefault;
  timestampFormat: "relative" | "absolute" | "both";
  wrapCode: boolean;
  liveFollow: boolean;
  turnMinimap: boolean;
}

export interface PersistedServerSettings {
  version: 1;
  settings: ServerViewerSettings;
}

export interface PersistedPresentationSettings {
  version: 1;
  settings: PresentationSettings;
}

export interface ViewerSettings {
  server: ServerViewerSettings;
  presentation: PresentationSettings;
}

export const DEFAULT_SERVER_PORT = 3_000;
export const DEFAULT_FETCH_FAVICONS = true;
export const PRESENTATION_SETTINGS_STORAGE_KEY =
  "codex-sessions-viewer:presentation:v1";

export const DEFAULT_PRESENTATION_SETTINGS: Readonly<PresentationSettings> =
  Object.freeze({
    theme: "midnight-glass",
    toolCallsDefault: "collapsed",
    reasoningDefault: "collapsed",
    timestampFormat: "both",
    wrapCode: false,
    liveFollow: true,
    turnMinimap: true,
  });

export const serverViewerSettingsSchema = z.strictObject({
  codexHome: z.string().trim().min(1),
  port: z.int().min(1).max(65_535),
  fetchFavicons: z.boolean(),
});

export const presentationSettingsSchema = z.strictObject({
  theme: viewerThemeSchema,
  toolCallsDefault: disclosureDefaultSchema,
  reasoningDefault: disclosureDefaultSchema,
  timestampFormat: z.enum(["relative", "absolute", "both"]),
  wrapCode: z.boolean(),
  liveFollow: z.boolean(),
  turnMinimap: z.boolean(),
});

export const persistedServerSettingsSchema = z.strictObject({
  version: z.literal(1),
  settings: serverViewerSettingsSchema,
});

export const persistedPresentationSettingsSchema = z.strictObject({
  version: z.literal(1),
  settings: presentationSettingsSchema,
});

export const viewerSettingsSchema = z.strictObject({
  server: serverViewerSettingsSchema,
  presentation: presentationSettingsSchema,
});

const presentationMigrationSchema = z.object({
  theme: viewerThemeSchema
    .catch(DEFAULT_PRESENTATION_SETTINGS.theme)
    .default(DEFAULT_PRESENTATION_SETTINGS.theme),
  toolCallsDefault: disclosureDefaultSchema
    .catch(DEFAULT_PRESENTATION_SETTINGS.toolCallsDefault)
    .default(DEFAULT_PRESENTATION_SETTINGS.toolCallsDefault),
  reasoningDefault: disclosureDefaultSchema
    .catch(DEFAULT_PRESENTATION_SETTINGS.reasoningDefault)
    .default(DEFAULT_PRESENTATION_SETTINGS.reasoningDefault),
  timestampFormat: z
    .enum(["relative", "absolute", "both"])
    .catch(DEFAULT_PRESENTATION_SETTINGS.timestampFormat)
    .default(DEFAULT_PRESENTATION_SETTINGS.timestampFormat),
  wrapCode: z
    .boolean()
    .catch(DEFAULT_PRESENTATION_SETTINGS.wrapCode)
    .default(DEFAULT_PRESENTATION_SETTINGS.wrapCode),
  liveFollow: z
    .boolean()
    .catch(DEFAULT_PRESENTATION_SETTINGS.liveFollow)
    .default(DEFAULT_PRESENTATION_SETTINGS.liveFollow),
  turnMinimap: z
    .boolean()
    .catch(DEFAULT_PRESENTATION_SETTINGS.turnMinimap)
    .default(DEFAULT_PRESENTATION_SETTINGS.turnMinimap),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migratePresentationSettings(
  persisted: unknown,
): PresentationSettings {
  const current = persistedPresentationSettingsSchema.safeParse(persisted);
  if (current.success) {
    return current.data.settings;
  }

  const candidate =
    isRecord(persisted) && "settings" in persisted
      ? persisted.settings
      : persisted;
  const migrated = presentationMigrationSchema.safeParse(candidate);

  return migrated.success
    ? migrated.data
    : { ...DEFAULT_PRESENTATION_SETTINGS };
}

export function serializePresentationSettings(
  settings: PresentationSettings,
): PersistedPresentationSettings {
  return persistedPresentationSettingsSchema.parse({
    version: 1,
    settings,
  });
}
