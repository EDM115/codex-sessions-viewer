import type { RepositoryMode } from "#shared/types/repository.ts";

import { LiveApiConversationRepository, type RepositoryRequester } from "./live.ts";
import { StaticConversationRepository, type PagefindLoader } from "./static.ts";

export function createConversationRepository(
  mode: RepositoryMode,
  requester?: RepositoryRequester,
  pagefindLoader?: PagefindLoader,
) {
  return mode === "static"
    ? new StaticConversationRepository(requester, pagefindLoader)
    : new LiveApiConversationRepository(requester);
}
