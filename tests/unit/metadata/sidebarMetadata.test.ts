import { describe, expect, it } from "vitest";

import { resolveSidebarMetadata } from "../../../server/metadata/sidebarMetadata.ts";
import { metadata, thread } from "../library/membershipFixtures.ts";

describe("scoped sidebar metadata", () => {
  it("retains native fallback for members not covered by a qualified custom translation", () => {
    const source = metadata({
      threads: [
        thread("mapped", { sectionId: "native-s" }),
        thread("unmapped", { sectionId: "native-s" }),
      ],
      sections: [{ id: "native-s", name: "Native" }],
      globalState: {
        projects: [],
        pinnedThreadIds: [],
        sectionsByIdentity: {
          scope: {
            sections: [{ id: "custom-s", name: "Custom", hostSectionIds: { local: "native-s" } }],
            threadHostIds: { mapped: "local" },
          },
        },
      },
    });
    expect(resolveSidebarMetadata(source)).toMatchObject({
      sections: [
        { id: "custom:scope:custom-s", threadIds: ["mapped"] },
        { id: "native:native-s", threadIds: ["unmapped"] },
      ],
      diagnostics: ["unknown-section-host"],
    });
  });
  it("requires selected account scope even for a sole matching local thread, then accepts its hashed scope seam", () => {
    const identityScopeKey = "a".repeat(64);
    const source = metadata({
      threads: [thread("t")],
      globalState: {
        projects: [],
        pinnedThreadIds: [],
        sectionsByIdentity: {
          [identityScopeKey]: {
            sections: [{ id: "s", name: "Account section", itemKeys: ["codex:thread:local:t"] }],
            threadHostIds: { t: "local" },
          },
        },
      },
    });
    expect(resolveSidebarMetadata(source)).toMatchObject({
      sections: [],
      diagnostics: ["unknown-section-identity"],
    });
    expect(resolveSidebarMetadata(source, { identityScopeKey })).toMatchObject({
      sections: [{ id: `custom:${identityScopeKey}:s`, threadIds: ["t"] }],
      diagnostics: [],
    });
  });
  it("rejects foreign-host pin keys and preserves explicit local project pin order", () => {
    const source = metadata({
      threads: [thread("t")],
      projects: [{ id: "p", name: "P", roots: [] }],
      globalState: {
        projects: [],
        pinnedThreadIds: [],
        unifiedPinnedOrder: [
          "codex:thread:remote:t",
          "codex:project:remote:p",
          "codex:project:local:p",
        ],
        threadProjectMembershipHostIds: { t: "local" },
      },
    });
    expect(resolveSidebarMetadata(source)).toMatchObject({
      preferences: { pinnedOrder: [], pinnedProjectOrder: ["p"] },
      diagnostics: ["pin-host-mismatch"],
    });
  });
  it("translates native sections and namespaced project/thread keys only for a known host and identity", () => {
    const source = metadata({
      threads: [thread("t", { sectionId: "native-section" }), thread("other")],
      projects: [{ id: "p", name: "P", roots: [] }],
      sections: [{ id: "native-section", name: "Review" }],
      globalState: {
        projects: [],
        pinnedThreadIds: [],
        sectionsByIdentity: {
          scope: {
            sections: [
              {
                id: "review",
                name: "Review",
                itemKeys: ["codex:project:local:p", "codex:thread:remote:other"],
                hostSectionIds: { local: "native-section" },
              },
            ],
            sectionOrder: ["custom:review"],
            threadHostIds: { t: "local", other: "local" },
          },
        },
      },
    });
    expect(resolveSidebarMetadata(source)).toMatchObject({
      sections: [
        { id: "custom:scope:review", name: "Review", threadIds: ["t"], projectIds: ["p"] },
      ],
      diagnostics: ["section-host-mismatch"],
    });
  });
  it("falls back to ordinary grouping for unknown account scopes or ambiguous host translations", () => {
    const source = metadata({
      threads: [thread("t", { sectionId: "native-section" })],
      sections: [{ id: "native-section", name: "Review" }],
      globalState: {
        projects: [],
        pinnedThreadIds: [],
        sectionsByIdentity: {
          a: { sections: [{ id: "s", name: "A", itemKeys: ["codex:thread:local:t"] }] },
          b: { sections: [{ id: "s", name: "B", itemKeys: ["codex:thread:local:t"] }] },
        },
      },
    });
    expect(resolveSidebarMetadata(source)).toMatchObject({
      sections: [{ id: "native:native-section", name: "Review", threadIds: ["t"] }],
      diagnostics: ["ambiguous-section-identity"],
    });
    source.globalState.sectionsByIdentity = {
      a: {
        sections: [
          {
            id: "s",
            name: "A",
            hostSectionIds: { local: "native-section", remote: "native-section" },
          },
        ],
      },
    };
    expect(resolveSidebarMetadata(source)).toMatchObject({
      sections: [{ id: "native:native-section", name: "Review", threadIds: ["t"] }],
      diagnostics: ["unknown-section-host"],
    });
  });
  it("preserves native pin/section positions and remaps explicit JSON project/chat ordering", () => {
    const source = metadata({
      projects: [{ id: "native", name: "P", roots: [] }],
      threads: [thread("t", { pinned: true, sectionPosition: 4 })],
      globalState: {
        projects: [],
        pinnedThreadIds: ["legacy-pin"],
        projectIdByLegacyIdByHost: { local: { old: "native" } },
        unifiedProjectOrder: ["codex:project:local:old"],
        unifiedPinnedOrder: [
          "codex:thread:local:t",
          { kind: "thread", threadId: "legacy-pin", hostId: "local" },
        ],
        projectThreadOrders: { old: ["t"] },
        sidebarPreferences: { chatSortMode: "updated_at", projectSortMode: "manual" },
      },
    });
    expect(resolveSidebarMetadata(source).preferences).toMatchObject({
      projectOrder: ["native"],
      pinnedOrder: ["t", "legacy-pin"],
      projectThreadOrders: { native: ["t"] },
      chatSortMode: "updated_at",
    });
  });
});
