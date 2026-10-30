import { describe, expect, it } from "vitest";

import { resolveThreadMembership, catalogProjects } from "#shared/library/projectIdentity.ts";

import { metadata, thread } from "./membershipFixtures.ts";

describe("resolveThreadMembership", () => {
  it("keeps explicit projectless ahead of native membership and cwd", () => {
    const source = metadata({
      threads: [thread("t", { projectId: "native" })],
      projects: [{ id: "native", name: "Saved", roots: [{ position: 0, path: "C:/Work" }] }],
      globalState: { projects: [], pinnedThreadIds: [], projectlessThreadIds: ["t"] },
    });
    expect(resolveThreadMembership("t", source)).toMatchObject({
      projectId: null,
      source: "explicit-projectless",
    });
  });
  it("preserves valid native IDs with identical roots and ordered multiple roots", () => {
    const source = metadata({
      threads: [thread("t", { projectId: "b" })],
      projects: [
        { id: "a", name: "A", roots: [{ position: 0, path: "C:/Work" }] },
        {
          id: "b",
          name: "B",
          roots: [
            { position: 9, path: "D:/Second" },
            { position: 1, path: "C:/Work" },
          ],
        },
      ],
    });
    expect(resolveThreadMembership("t", source)).toMatchObject({
      projectId: "b",
      source: "native",
    });
    expect(catalogProjects(source).map((p) => [p.id, p.rootPaths])).toEqual([
      ["a", ["C:/Work"]],
      ["b", ["C:/Work", "D:/Second"]],
    ]);
  });
  it("remaps explicit legacy assignments using their host without guessing a dangling destination", () => {
    const source = metadata({
      threads: [thread("t")],
      projects: [{ id: "native", name: "Saved", roots: [] }],
      globalState: {
        projects: [{ id: "legacy", name: "Same", rootPaths: ["C:/Work"] }],
        pinnedThreadIds: [],
        threadProjectAssignments: { t: { projectKind: "local", projectId: "legacy" } },
        threadProjectMembershipHostIds: { t: "local" },
        projectIdByLegacyIdByHost: { local: { legacy: "native" }, other: { legacy: "wrong" } },
      },
    });
    expect(resolveThreadMembership("t", source)).toMatchObject({
      projectId: "native",
      source: "legacy-assignment",
    });
    source.globalState.projectIdByLegacyIdByHost = { local: { legacy: "missing" } };
    expect(resolveThreadMembership("t", source)).toMatchObject({
      projectId: null,
      diagnostics: ["dangling-legacy-migration"],
    });
  });
  it("limits root inference to supported legacy roots and rejects equal-root ambiguity", () => {
    const source = metadata({
      threads: [thread("t", { cwd: "\\\\SERVER/share/Work/child" })],
      projects: [
        {
          id: "native-only",
          name: "Native",
          roots: [{ position: 0, path: "\\\\server\\share\\Work" }],
        },
      ],
      globalState: {
        projects: [{ id: "legacy", name: "Legacy", rootPaths: ["\\\\server\\SHARE\\work"] }],
        pinnedThreadIds: [],
      },
    });
    expect(resolveThreadMembership("t", source)).toMatchObject({
      projectId: "legacy",
      source: "legacy-root",
    });
    source.globalState.projects.push({
      id: "second",
      name: "Second",
      rootPaths: ["//SERVER/share/WORK/"],
    });
    expect(resolveThreadMembership("t", source)).toMatchObject({
      projectId: null,
      diagnostics: ["ambiguous-legacy-root"],
    });
    source.globalState.projects = [];
    expect(resolveThreadMembership("t", source).projectId).toBeNull();
  });
  it("does not repair a dangling explicit assignment from matching roots", () => {
    const source = metadata({
      threads: [thread("t")],
      globalState: {
        projects: [{ id: "saved", name: "Saved", rootPaths: ["c:/work"] }],
        pinnedThreadIds: [],
        threadProjectAssignments: { t: { projectKind: "local", projectId: "missing" } },
      },
    });
    expect(resolveThreadMembership("t", source)).toMatchObject({
      projectId: null,
      diagnostics: ["dangling-legacy-assignment"],
    });
  });
});
