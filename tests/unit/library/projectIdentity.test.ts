import { describe, expect, it } from "vitest";

import { resolveConversationProject } from "../../../shared/library/projectIdentity.ts";

describe("resolveConversationProject", () => {
  it("uses the longest case-insensitive Codex project-root match on Windows", () => {
    expect(
      resolveConversationProject(
        {
          cwd: "C:\\Work\\repo\\packages\\app",
          gitOriginUrl: "https://example.test/repo.git",
        },
        [
          { id: "broad", name: "Work", rootPaths: ["C:\\Work"] },
          { id: "repo", name: "Repo", rootPaths: ["c:\\work\\repo"] },
        ],
      ),
    ).toMatchObject({ id: "codex:repo", source: "codex", name: "Repo" });
  });

  it("requires a directory boundary after a candidate project root", () => {
    expect(
      resolveConversationProject({ cwd: "C:\\Workshop", gitOriginUrl: null }, [
        { id: "work", name: "Work", rootPaths: ["C:\\Work"] },
      ]),
    ).toMatchObject({ source: "cwd", name: "Workshop" });
  });

  it.each([
    ["/", "/work/viewer", "/"],
    ["C:\\", "c:/Work/viewer", "C:\\"],
  ])(
    "matches descendants and the root itself for filesystem root %s",
    (root, descendant, exact) => {
      const projects = [{ id: "filesystem-root", name: "Filesystem root", rootPaths: [root] }];
      for (const cwd of [descendant, exact]) {
        expect(resolveConversationProject({ cwd, gitOriginUrl: null }, projects)).toEqual({
          id: "codex:filesystem-root",
          name: "Filesystem root",
          source: "codex",
          hint: root,
        });
      }
    },
  );

  it("falls back through Git origin, cwd, and No project without filesystem traversal", () => {
    const git = resolveConversationProject(
      { cwd: "/work/different-cwd-project", gitOriginUrl: "https://github.com/openai/codex.git" },
      [],
    );
    const cwd = resolveConversationProject(
      { cwd: "/work/packages/viewer", gitOriginUrl: null },
      [],
    );
    const none = resolveConversationProject({ cwd: null, gitOriginUrl: null }, []);

    expect(git).toMatchObject({ source: "git", name: "codex" });
    expect(git.id).toMatch(/^git:/u);
    expect(cwd).toMatchObject({ source: "cwd", name: "viewer" });
    expect(cwd.id).toMatch(/^cwd:/u);
    expect(none).toEqual({
      id: "none",
      name: "No project",
      source: "none",
      hint: null,
    });
  });

  it("keeps same-basename origins distinct and normalizes equivalent Windows cwd identities", () => {
    const first = resolveConversationProject(
      { cwd: null, gitOriginUrl: "ssh://git@example.test/team/repo.git" },
      [],
    );
    const second = resolveConversationProject(
      { cwd: null, gitOriginUrl: "ssh://git@example.test/other-team/repo.git" },
      [],
    );

    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ name: "repo", hint: "ssh://git@example.test/team/repo.git" });
    expect(second).toMatchObject({
      name: "repo",
      hint: "ssh://git@example.test/other-team/repo.git",
    });
    const windows = resolveConversationProject(
      { cwd: "C:\\Work\\Viewer\\", gitOriginUrl: null },
      [],
    );
    const equivalent = resolveConversationProject(
      { cwd: "c:/work/viewer", gitOriginUrl: null },
      [],
    );
    expect(windows.id).toBe(equivalent.id);
    expect(windows.hint).toBe("C:\\Work\\Viewer\\");
    expect(equivalent.hint).toBe("c:/work/viewer");
  });
});
