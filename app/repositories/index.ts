import type { ConversationRepository, RepositoryMode } from "#shared/types/repository.ts";
import { LiveApiConversationRepository, type RepositoryRequester } from "~/repositories/live.ts";
import { StaticConversationRepository, type PagefindLoader } from "~/repositories/static.ts";

export function createConversationRepository(
  mode: RepositoryMode,
  requester?: RepositoryRequester,
  pagefindLoader?: PagefindLoader,
): ConversationRepository {
  return mode === "static"
    ? new StaticConversationRepository(requester, pagefindLoader)
    : new LiveApiConversationRepository(requester);
}
