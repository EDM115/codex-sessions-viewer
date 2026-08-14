import type { DatabaseSync } from "node:sqlite";

import type {
  RichTextDocument,
  RichTextNode,
  EmbeddedMediaSource,
} from "../../shared/types/richText.ts";
import { storeEmbeddedMedia, storeReferencedMedia } from "../content/extractMedia.ts";
import { resolveFavicon, type FaviconResolution } from "../content/favicons.ts";
import { parseRichText } from "../content/parseRichText.ts";
import { discoverReferencedLocalMedia } from "../ingestion/discoverSources.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";

export interface PrepareConversationExportOptions {
  mediaRoot: string;
  faviconRoot: string;
  offline: boolean;
  mode?: "export" | "live" | undefined;
}

export interface PreparedConversationExport {
  conversation: NormalizedSession;
  assetIds: Set<string>;
  faviconOrigins: Set<string>;
  faviconResults: FaviconResolution[];
}

function collectDocumentReferences(
  document: RichTextDocument,
  origins: Set<string>,
  assetIds: Set<string>,
): void {
  const collect = (nodes: readonly RichTextNode[]): void => {
    for (const node of nodes) {
      if (node.type === "link" && node.origin !== null) {
        origins.add(node.origin);
      }
      if (node.type === "media" && node.assetId !== null) {
        assetIds.add(node.assetId);
      }
      if ("children" in node) {
        collect(node.children);
      }
    }
  };
  collect(document.children);
}

function isNormalizerPlaceholder(document: RichTextDocument, source: string): boolean {
  return source === ""
    ? document.children.length === 0
    : document.children.length === 1 &&
        document.children[0]?.type === "text" &&
        document.children[0].text === source;
}

export async function prepareConversationForExport(
  database: DatabaseSync,
  source: NormalizedSession,
  options: PrepareConversationExportOptions,
): Promise<PreparedConversationExport> {
  const conversation = structuredClone(source);
  const mediaActivities = conversation.turns.flatMap(({ activities }) =>
    activities.filter((activity) => activity.kind === "media"),
  );
  const references = discoverReferencedLocalMedia(mediaActivities);
  const assetIdsByPath = new Map(references.map(({ path, assetId }) => [path, assetId]));
  const embeddedMedia: EmbeddedMediaSource[] = [];
  const faviconOrigins = new Set<string>();
  const assetIds = new Set(references.map(({ assetId }) => assetId));
  for (const turn of conversation.turns) {
    const messages = [turn.userMessage, ...turn.assistantMessages].filter(
      (message) => message !== null,
    );
    for (const message of messages) {
      if (isNormalizerPlaceholder(message.body, message.sourceMarkdown)) {
        // oxlint-disable-next-line no-await-in-loop -- Rich parsing is bounded and keeps message ordering deterministic.
        const parsed = await parseRichText(message.sourceMarkdown, { assetIdsByPath });
        message.body = parsed.document;
        embeddedMedia.push(...parsed.embeddedMedia);
      }
      collectDocumentReferences(message.body, faviconOrigins, assetIds);
    }
    for (const activity of turn.activities) {
      if (activity.kind !== "reasoning" || activity.summary === "") {
        continue;
      }
      if (activity.body === null || isNormalizerPlaceholder(activity.body, activity.summary)) {
        // oxlint-disable-next-line no-await-in-loop -- Visible reasoning uses the same bounded sanitizer as messages.
        const parsed = await parseRichText(activity.summary, { assetIdsByPath });
        activity.body = parsed.document;
        embeddedMedia.push(...parsed.embeddedMedia);
      }
      collectDocumentReferences(activity.body, faviconOrigins, assetIds);
    }
  }
  await storeReferencedMedia(database, references, {
    assetRoot: options.mediaRoot,
    sessionId: conversation.summary.id,
  });
  await storeEmbeddedMedia(database, embeddedMedia, {
    assetRoot: options.mediaRoot,
    sessionId: conversation.summary.id,
  });
  for (const media of embeddedMedia) {
    assetIds.add(media.assetId);
  }
  const faviconResults: FaviconResolution[] = [];
  for (const origin of [...faviconOrigins].toSorted()) {
    // oxlint-disable-next-line no-await-in-loop -- Export favicon requests are an intentional bounded origin cascade.
    const resolution = await resolveFavicon(database, origin, {
      mode: options.mode ?? "export",
      offline: options.offline,
      faviconRoot: options.faviconRoot,
    });
    faviconResults.push(resolution);
  }
  return {
    conversation,
    assetIds,
    faviconOrigins,
    faviconResults,
  };
}
