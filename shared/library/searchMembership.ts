import { buildSidebarGroups } from "#shared/library/sidebarGroups.ts";
import { isThreadVisible } from "#shared/library/threadVisibility.ts";
import { sidebarGroupKey, type CatalogLibrary } from "#shared/types/library.ts";
import type { SearchQuery } from "#shared/types/repository.ts";

export function searchMembershipIds(library: CatalogLibrary, query: SearchQuery): string[] {
  const group =
    query.groupId === undefined
      ? null
      : buildSidebarGroups(library, { ...library.preferences, scope: query.scope }).find(
          (candidate) => sidebarGroupKey(candidate) === query.groupId,
        );
  return library.threads
    .filter((thread) => {
      if (thread.scope !== query.scope || !isThreadVisible(thread.classification, "ordinary")) {
        return false;
      }
      if (query.projectId !== undefined && thread.projectId !== query.projectId) {
        return false;
      }
      if (query.groupId !== undefined && !group?.threadIds.includes(thread.id)) {
        return false;
      }
      // The root search scope includes delegated hits with parent navigation
      if (
        query.parentThreadId !== undefined &&
        query.parentThreadId !== "__root__" &&
        thread.classification.parentThreadId !== query.parentThreadId
      ) {
        return false;
      }
      return true;
    })
    .map((thread) => thread.id);
}
