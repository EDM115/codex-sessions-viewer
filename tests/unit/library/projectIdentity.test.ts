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

  it("falls back through Git origin, cwd, and No project without filesystem traversal", () => {
    const git = resolveConversationProject(
      { cwd: null, gitOriginUrl: "https://github.com/openai/codex.git" },
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

  it("produces stable fallback identities while preserving the full origin as the hint", () => {
    const first = resolveConversationProject(
      { cwd: null, gitOriginUrl: "ssh://git@example.test/team/repo.git" },
      [],
    );
    const second = resolveConversationProject(
      { cwd: null, gitOriginUrl: "ssh://git@example.test/team/repo.git" },
      [],
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({ name: "repo", hint: "ssh://git@example.test/team/repo.git" });
  });
});
