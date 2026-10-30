import {
  prepareHistoryPresentation,
  type HistoryPresentationMedia,
} from "#server/history/historyPresentation.ts";
import { historyItemAttachments } from "#shared/timeline/historyAttachments.ts";
import { historyItemMarkdown } from "#shared/timeline/historyPresentation.ts";
import type { SourceGeneration } from "#shared/types/conversation.ts";
import {
  historyPageSchema,
  type HistoryPage,
  type HistoryTurnWindow,
} from "#shared/types/history.ts";
import {
  STATIC_HISTORY_ITEM_CHUNK,
  staticHistoryCursor,
  staticHistoryManifestSchema,
} from "#shared/types/staticHistory.ts";

export async function writeStaticHistory(
  page: HistoryPage,
  write: (name: string, value: unknown) => Promise<void>,
  sourceGenerations?: readonly SourceGeneration[],
  media?: HistoryPresentationMedia,
) {
  historyPageSchema.parse(page);
  const { beforeCursor: _before, afterCursor: _after, turns: _turns, ...metadata } = page;
  const manifest = staticHistoryManifestSchema.parse({
    ...metadata,
    version: 1,
    turns: page.turns.map((turn) => ({
      turnId: turn.turnId,
      physicalRolloutId: turn.physicalRolloutId,
      chunks: Math.max(1, Math.ceil(turn.items.length / STATIC_HISTORY_ITEM_CHUNK)),
      itemCount: turn.items.length,
      itemChunks: Object.fromEntries([
        ...(turn.opening.itemId ? [[turn.opening.itemId, 0] as const] : []),
        ...turn.items.map(
          (item, index) => [item.itemId, Math.floor(index / STATIC_HISTORY_ITEM_CHUNK)] as const,
        ),
      ]),
    })),
  });
  // oxlint-disable no-await-in-loop -- Serialize one bounded source-qualified window and its saved rich text before releasing it
  for (const [turnIndex, turn] of page.turns.entries()) {
    const chunkCount = manifest.turns[turnIndex]!.chunks;
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const items = turn.items.slice(
        chunk * STATIC_HISTORY_ITEM_CHUNK,
        (chunk + 1) * STATIC_HISTORY_ITEM_CHUNK,
      );
      const window: HistoryTurnWindow = {
        ...turn,
        items,
        beforeCursor:
          chunk === 0
            ? null
            : staticHistoryCursor(manifest, "item", chunk * STATIC_HISTORY_ITEM_CHUNK, turn.turnId),
        afterCursor:
          chunk + 1 === chunkCount
            ? null
            : staticHistoryCursor(
                manifest,
                "item",
                (chunk + 1) * STATIC_HISTORY_ITEM_CHUNK,
                turn.turnId,
              ),
        itemsView: chunkCount === 1 ? turn.itemsView : "summary",
        coverage:
          chunkCount === 1
            ? turn.coverage
            : {
                ...turn.coverage,
                status: turn.coverage.status === "complete" ? "partial" : turn.coverage.status,
                gaps: [
                  ...turn.coverage.gaps,
                  {
                    physicalRolloutId: turn.physicalRolloutId,
                    turnId: turn.turnId,
                    reason: "saved-items-not-loaded",
                    beforeOrdinal: null,
                    afterOrdinal: null,
                  },
                ],
              },
      };
      const richItems = new Map([
        ...(window.opening.item ? [[window.opening.item.id, window.opening.item] as const] : []),
        ...items.flatMap(({ item }) => (item ? [[item.id, item] as const] : [])),
      ]);
      const presentations = [];
      for (const item of richItems.values()) {
        const markdown = historyItemMarkdown(item);
        if (markdown !== null) {
          presentations.push(
            await prepareHistoryPresentation(
              {
                threadId: page.threadId,
                historyEpoch: page.historyEpoch,
                contentRevision: page.contentRevision,
                physicalRolloutId: turn.physicalRolloutId,
                turnId: turn.turnId,
                itemId: item.id,
                markdown,
                ...(historyItemAttachments(item).length
                  ? { attachments: historyItemAttachments(item) }
                  : {}),
              },
              undefined,
              media,
            ),
          );
        }
      }
      await write(`history-${turnIndex}-${chunk}.json`, {
        version: 1,
        threadId: page.threadId,
        window,
        presentations,
      });
    }
  }
  // oxlint-enable no-await-in-loop
  await write("history-index.json", {
    ...manifest,
    ...(sourceGenerations ? { sourceGenerations } : {}),
  });
}
