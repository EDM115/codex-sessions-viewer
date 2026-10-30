import { isThreadVisible } from "#shared/library/threadVisibility.ts";
import {
  type CatalogLibrary,
  type CatalogSidebarThread,
  type SidebarGroup,
  type SidebarPreferences,
  sidebarGroupKey,
  type CatalogProjectGroup,
} from "#shared/types/library.ts";

export function catalogProjectGroups(catalog: CatalogLibrary): CatalogProjectGroup[] {
  const active = buildSidebarGroups(catalog, { ...catalog.preferences, scope: "active" });
  const archived = buildSidebarGroups(catalog, { ...catalog.preferences, scope: "archived" });
  return [
    ...active,
    ...archived.filter(
      (group) => !active.some((other) => sidebarGroupKey(other) === sidebarGroupKey(group)),
    ),
  ].map((group) => {
    const groupId = sidebarGroupKey(group);
    const project =
      group.kind === "project"
        ? catalog.projects.find((candidate) => candidate.id === group.projectId)
        : undefined;
    return {
      id: group.id,
      name: group.name,
      rootPaths: project?.rootPaths ?? [],
      hostId: project?.hostId ?? null,
      source: project?.source ?? "legacy",
      position: project?.position ?? null,
      recencyAt: project?.recencyAt ?? null,
      groupId,
      activeCount:
        active.find((candidate) => sidebarGroupKey(candidate) === groupId)?.threadIds.length ?? 0,
      archivedCount:
        archived.find((candidate) => sidebarGroupKey(candidate) === groupId)?.threadIds.length ?? 0,
      sidebar: {
        order: {
          active: active.findIndex((candidate) => sidebarGroupKey(candidate) === groupId),
          archived: archived.findIndex((candidate) => sidebarGroupKey(candidate) === groupId),
        },
        kind: group.kind,
        sectionId: group.sectionId,
        sectionName: group.sectionId
          ? (catalog.sections.find((section) => section.id === group.sectionId)?.name ?? null)
          : null,
      },
    };
  });
}

function index(order: readonly string[], id: string): number {
  const position = order.indexOf(id);
  return position < 0 ? Infinity : position;
}

export function buildSidebarGroups(
  catalog: CatalogLibrary,
  preferences: SidebarPreferences,
): SidebarGroup[] {
  const roots = catalog.threads.filter(
    (thread) =>
      thread.scope === preferences.scope && isThreadVisible(thread.classification, "root"),
  );
  const orderThreads = (threads: CatalogSidebarThread[], order: string[]) =>
    threads
      .toSorted((a, b) => {
        const pinA = a.pinned || preferences.pinnedOrder.includes(a.id);
        const pinB = b.pinned || preferences.pinnedOrder.includes(b.id);
        if (pinA !== pinB) {
          return pinA ? -1 : 1;
        }
        if (pinA) {
          const difference =
            index(preferences.pinnedOrder, a.id) - index(preferences.pinnedOrder, b.id);
          if (difference) {
            return difference;
          }
        }
        if (preferences.chatSortMode === "manual") {
          const difference = index(order, a.id) - index(order, b.id);
          if (difference) {
            return difference;
          }
          const position = (a.sectionPosition ?? Infinity) - (b.sectionPosition ?? Infinity);
          if (position) {
            return position;
          }
        } else {
          const difference = (b.recencyAt ?? -Infinity) - (a.recencyAt ?? -Infinity);
          if (difference) {
            return difference;
          }
        }
        return a.id.localeCompare(b.id);
      })
      .map((thread) => thread.id);
  const projects = catalog.projects.toSorted((a, b) => {
    const pinDifference =
      index(preferences.pinnedProjectOrder ?? [], a.id) -
      index(preferences.pinnedProjectOrder ?? [], b.id);
    if (pinDifference) {
      return pinDifference;
    }
    if (preferences.projectSortMode === "manual") {
      const difference =
        index(preferences.projectOrder, a.id) - index(preferences.projectOrder, b.id);
      if (difference) {
        return difference;
      }
      const position = (a.position ?? Infinity) - (b.position ?? Infinity);
      if (position) {
        return position;
      }
    } else {
      const recency = (id: string, fallback: number | null) =>
        Math.max(
          fallback ?? -Infinity,
          ...roots
            .filter((thread) => thread.projectId === id)
            .map((thread) => thread.recencyAt ?? -Infinity),
        );
      const difference = recency(b.id, b.recencyAt) - recency(a.id, a.recencyAt);
      if (difference) {
        return difference;
      }
    }
    return a.id.localeCompare(b.id);
  });
  const claimedThreads = new Set<string>();
  const claimedProjects = new Set<string>();
  const sections = catalog.sections
    .toSorted(
      (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.id.localeCompare(b.id),
    )
    .flatMap((section) => {
      if (!section.name.trim()) {
        return [];
      }
      const projectIds = projects
        .filter(
          (project) => section.projectIds.includes(project.id) && !claimedProjects.has(project.id),
        )
        .map((project) => project.id);
      const threads = roots.filter(
        (thread) =>
          section.threadIds.includes(thread.id) &&
          !claimedThreads.has(thread.id) &&
          !projectIds.includes(thread.projectId ?? ""),
      );
      if (!projectIds.length && !threads.length) {
        return [];
      }
      projectIds.forEach((id) => claimedProjects.add(id));
      threads.forEach((thread) => claimedThreads.add(thread.id));
      return [
        {
          id: section.id,
          name: section.name,
          kind: "section" as const,
          projectId: null,
          sectionId: section.id,
          projectIds,
          threadIds: orderThreads(threads, section.threadIds),
        },
      ];
    });
  const projectGroup = (
    project: (typeof projects)[number],
    sectionId: string | null,
  ): SidebarGroup => ({
    id: project.id,
    name: project.name,
    kind: "project",
    projectId: project.id,
    sectionId,
    projectIds: [],
    threadIds: orderThreads(
      roots.filter((thread) => thread.projectId === project.id && !claimedThreads.has(thread.id)),
      preferences.projectThreadOrders[project.id] ?? [],
    ),
  });
  const groups = projects
    .filter((project) => !claimedProjects.has(project.id))
    .map((project) => projectGroup(project, null));
  for (const section of sections) {
    groups.push(section);
    groups.push(
      ...projects
        .filter((project) => section.projectIds.includes(project.id))
        .map((project) => projectGroup(project, section.id)),
    );
  }
  groups.push({
    id: "none",
    name: "Recents",
    kind: "recents",
    projectId: null,
    sectionId: null,
    projectIds: [],
    threadIds: orderThreads(
      roots.filter((thread) => thread.projectId === null && !claimedThreads.has(thread.id)),
      [],
    ),
  });
  return groups;
}
