import type { CatalogMetadataSnapshot } from "#server/metadata/catalogMetadata.ts";
import type { SidebarPreferences, SidebarSection } from "#shared/types/library.ts";

interface SidebarItemKey {
  kind: "thread" | "project";
  hostId: string;
  id: string;
}
function itemKey(value: string): SidebarItemKey | null {
  const match = /^codex:(thread|project):([^:]+):(.+)$/u.exec(value);
  return match && (match[1] === "thread" || match[1] === "project")
    ? { kind: match[1], hostId: match[2]!, id: match[3]! }
    : null;
}

export function resolveSidebarMetadata(
  metadata: Pick<CatalogMetadataSnapshot, "threads" | "projects" | "sections" | "globalState">,
  options: { identityScopeKey?: string | undefined } = {},
): {
  sections: SidebarSection[];
  preferences: SidebarPreferences;
  diagnostics: string[];
  qualifiedSectionIdentity: string | null;
  sectionItemCoverage: Record<string, "complete" | "partial">;
} {
  const global = metadata.globalState;
  const diagnostics: string[] = [];
  const availableIdentities = Object.entries(global.sectionsByIdentity ?? {});
  const nativeSectionIds = new Set(metadata.sections.map((section) => section.id));
  const identities = options.identityScopeKey
    ? availableIdentities.filter(
        ([key]) =>
          /^[a-f0-9]{64}$/iu.test(options.identityScopeKey!) && key === options.identityScopeKey,
      )
    : availableIdentities.filter(([, state]) =>
        state.sections?.some(
          (section) =>
            section.hostSectionIds?.["local"] &&
            nativeSectionIds.has(section.hostSectionIds["local"]),
        ),
      );
  if (identities.length !== 1 && (availableIdentities.length || options.identityScopeKey)) {
    diagnostics.push(
      identities.length > 1 || (!options.identityScopeKey && availableIdentities.length > 1)
        ? "ambiguous-section-identity"
        : "unknown-section-identity",
    );
  }
  const qualified = identities.length === 1 ? identities : [];
  const projectIds = new Set(metadata.projects.map((project) => project.id));
  global.projects.forEach((project) => projectIds.add(project.id));
  function projectId(id: string, hostId?: string): string | null {
    if (hostId && hostId !== "local" && !global.projectIdByLegacyIdByHost?.[hostId]?.[id]) {
      diagnostics.push("unknown-project-order-host");
      return null;
    }
    if (metadata.projects.some((project) => project.id === id)) {
      return id;
    }
    const maps = global.projectIdByLegacyIdByHost ?? {};
    const mapped = hostId
      ? maps[hostId]?.[id]
      : [...new Set(Object.values(maps).flatMap((map) => (map[id] ? [map[id]] : [])))];
    if (Array.isArray(mapped)) {
      if (mapped.length === 1 && projectIds.has(mapped[0]!)) {
        return mapped[0]!;
      }
      if (mapped.length) {
        diagnostics.push("ambiguous-project-order-host");
        return null;
      }
    } else if (mapped) {
      return projectIds.has(mapped) ? mapped : null;
    }
    return global.projects.some((project) => project.id === id) ? id : null;
  }
  const decodeProject = (value: string) => {
    const key = itemKey(value);
    return key ? (key.kind === "project" ? projectId(key.id, key.hostId) : null) : projectId(value);
  };
  const projectOrder = (global.unifiedProjectOrder ?? global.projectOrder ?? []).flatMap(
    (value) => {
      const id = decodeProject(value);
      return id ? [id] : [];
    },
  );
  const pinnedOrder: string[] = [];
  const pinnedProjectOrder: string[] = [];
  const scopedStates = qualified.map(([, state]) => state);
  function pinHostMatches(key: SidebarItemKey): boolean {
    const host =
      key.kind === "thread"
        ? (global.threadProjectMembershipHostIds?.[key.id] ??
          (scopedStates.length === 1 ? scopedStates[0]?.threadHostIds?.[key.id] : undefined) ??
          "local")
        : global.projectIdByLegacyIdByHost?.[key.hostId]?.[key.id]
          ? key.hostId
          : "local";
    if (host === key.hostId) {
      return true;
    }
    diagnostics.push("pin-host-mismatch");
    return false;
  }
  for (const value of global.unifiedPinnedOrder ?? global.pinnedThreadIds) {
    if (typeof value === "string") {
      const key = itemKey(value);
      if (key && !pinHostMatches(key)) {
        continue;
      }
      if (key?.kind === "project") {
        const id = projectId(key.id, key.hostId);
        if (id) {
          pinnedProjectOrder.push(id);
        }
      } else if (key?.kind === "thread") {
        pinnedOrder.push(key.id);
      } else if (!value.startsWith("codex:")) {
        pinnedOrder.push(value);
      }
    } else {
      const key = value.key ? itemKey(value.key) : null;
      const structuredKey =
        key ??
        (value.hostId && (value.threadId || value.projectId)
          ? {
              kind: value.projectId ? ("project" as const) : ("thread" as const),
              hostId: value.hostId,
              id: value.projectId ?? value.threadId!,
            }
          : null);
      if (structuredKey && !pinHostMatches(structuredKey)) {
        continue;
      }
      if (key?.kind === "project" || value.projectId) {
        const id = projectId(value.projectId ?? key!.id, value.hostId ?? key?.hostId);
        if (id) {
          pinnedProjectOrder.push(id);
        }
      } else if (
        key?.kind === "thread" ||
        value.threadId ||
        value.kind === "thread" ||
        value.type === "thread"
      ) {
        const id = value.threadId ?? key?.id ?? value.id;
        if (id) {
          pinnedOrder.push(id);
        }
      }
    }
  }
  const projectThreadOrders = Object.fromEntries(
    Object.entries(global.projectThreadOrders ?? {}).flatMap(([key, ids]) => {
      const id = decodeProject(key);
      return id ? [[id, ids]] : [];
    }),
  );
  const preferences: SidebarPreferences = {
    scope: "active",
    chatSortMode:
      global.sidebarPreferences?.chatSortMode ??
      global.sidebarPreferences?.sortOrder ??
      "updated_at",
    projectSortMode: global.sidebarPreferences?.projectSortMode ?? "manual",
    projectOrder,
    projectThreadOrders,
    pinnedOrder,
    pinnedProjectOrder,
  };
  const sections: SidebarSection[] = [];
  const sectionItemCoverage: Record<string, "complete" | "partial"> = {};
  const mappedNativeThreads = new Set<string>();
  if (qualified.length === 1) {
    const [identity, state] = qualified[0]!;
    for (const section of state.sections ?? []) {
      const id = `custom:${identity}:${section.id}`;
      const threadIds = new Set<string>();
      const projects = new Set<string>();
      const itemList = section.itemKeys ?? section.items;
      let completeItems = itemList !== undefined;
      for (const value of itemList ?? []) {
        const key = itemKey(value);
        if (!key) {
          completeItems = false;
          diagnostics.push("unsupported-section-item-key");
          continue;
        }
        if (section.pendingDeletionHostIdsByItemKey?.[value]?.includes(key.hostId)) {
          continue;
        }
        if (key.kind === "project") {
          const mapped = projectId(key.id, key.hostId);
          if (
            mapped &&
            (key.hostId === "local" || global.projectIdByLegacyIdByHost?.[key.hostId]?.[key.id])
          ) {
            projects.add(mapped);
          } else {
            completeItems = false;
            diagnostics.push("unknown-section-project-host");
          }
        } else {
          const host =
            state.threadHostIds?.[key.id] ?? global.threadProjectMembershipHostIds?.[key.id];
          if (host === key.hostId) {
            threadIds.add(key.id);
          } else {
            completeItems = false;
            diagnostics.push(host ? "section-host-mismatch" : "unknown-section-host");
          }
        }
      }
      if (itemList !== undefined) {
        sectionItemCoverage[id] = completeItems ? "complete" : "partial";
      }
      for (const thread of metadata.threads) {
        if (!thread.sectionId) {
          continue;
        }
        const hosts = Object.entries(section.hostSectionIds ?? {})
          .filter(([, nativeId]) => nativeId === thread.sectionId)
          .map(([host]) => host);
        if (!hosts.length) {
          continue;
        }
        const host =
          state.threadHostIds?.[thread.id] ?? global.threadProjectMembershipHostIds?.[thread.id];
        if (host && hosts.includes(host)) {
          threadIds.add(thread.id);
          mappedNativeThreads.add(thread.id);
        } else {
          diagnostics.push("unknown-section-host");
        }
      }
      const position = state.sectionOrder?.indexOf(`custom:${section.id}`) ?? -1;
      sections.push({
        id,
        name: section.name,
        threadIds: [...threadIds],
        projectIds: [...projects],
        position: position >= 0 ? position : (section.position ?? null),
      });
    }
  }
  for (const section of metadata.sections) {
    sections.push({
      id: `native:${section.id}`,
      name: section.name,
      threadIds: metadata.threads
        .filter((thread) => thread.sectionId === section.id && !mappedNativeThreads.has(thread.id))
        .map((thread) => thread.id),
      projectIds: [],
      position: null,
    });
  }
  return {
    qualifiedSectionIdentity: qualified[0]?.[0] ?? null,
    sectionItemCoverage,
    sections: sections.filter((section) => section.threadIds.length || section.projectIds.length),
    preferences,
    diagnostics: [...new Set(diagnostics)],
  };
}
