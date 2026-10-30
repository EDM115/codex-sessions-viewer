import { conversationSummarySchema, type ConversationSummary } from "#shared/types/conversation.ts";
import type { CatalogSessionMetadata } from "#shared/types/library.ts";

// Explicit completed-content fixture for tests that exercise the selected legacy summary adapter
export function completeSummaryFixture(
  metadata: CatalogSessionMetadata,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  const {
    recencyAt: _recencyAt,
    metadataRevision: _metadataRevision,
    fieldSources: _fieldSources,
    metadataConflicts: _metadataConflicts,
    ...summary
  } = metadata;
  return conversationSummarySchema.parse({
    ...summary,
    createdAt: metadata.createdAt ?? "2026-08-13T08:00:00.000Z",
    updatedAt: metadata.updatedAt ?? "2026-08-13T08:30:00.000Z",
    models: [],
    reasoningEfforts: [],
    turnCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolCounts: {},
    preview: "",
    hasMedia: false,
    diagnosticCount: 0,
    ...overrides,
  });
}
