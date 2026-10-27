import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverMetadataSources } from "../../../server/ingestion/discoverSources.ts";
import { readGlobalState } from "../../../server/metadata/globalState.ts";
import { snapshotStateDatabase } from "../../../server/metadata/stateSnapshot.ts";
import { createStateDatabase } from "../../integration/source-boundary/fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "viewer-catalog-metadata-"));
  roots.push(path);
  return path;
}
async function snapshot(home: string) {
  return snapshotStateDatabase({
    sourceDatabase: join(home, "state_5.sqlite"),
    sourceWal: join(home, "state_5.sqlite-wal"),
    snapshotRoot: join(home, "viewer", "state"),
  });
}

describe("capability-aware state metadata", () => {
  it("diagnoses rejected appearance and root siblings without including raw rejected values", async () => {
    const home = await root();
    const db = createStateDatabase(join(home, "state_5.sqlite"));
    db.exec(
      `CREATE TABLE projects (id TEXT, name TEXT, metadata TEXT); INSERT INTO projects VALUES ('p','P','{"appearance.color":{"secret":"must-not-leak"},"appearance.marker":"star"}'); CREATE TABLE project_roots (project_id TEXT, position, path); INSERT INTO project_roots VALUES ('p',0,'C:/good'),('p','must-not-leak','C:/bad'),('p',2,NULL); ALTER TABLE thread_sections ADD COLUMN appearance TEXT; UPDATE thread_sections SET appearance='{"color":"blue","marker":{"secret":"must-not-leak"}}';`,
    );
    db.close();
    const result = await snapshot(home);
    expect(result.metadata?.projects?.[0]).toMatchObject({
      appearance: { marker: "star" },
      roots: [{ position: 0, path: "C:/good" }],
    });
    expect(result.metadata?.capabilities?.diagnostics).toEqual(
      expect.arrayContaining([
        { table: "projects", field: "appearance.color", reason: "invalid-field" },
        { table: "thread_sections", field: "appearance.marker", reason: "invalid-field" },
        { table: "project_roots", field: "position", reason: "invalid-field" },
        { table: "project_roots", field: "path", reason: "invalid-field" },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
  it("keeps old threads when optional columns and entire project/section tables are absent", async () => {
    const home = await root();
    const db = createStateDatabase(join(home, "state_5.sqlite"));
    db.exec(
      "ALTER TABLE threads DROP COLUMN name; ALTER TABLE threads DROP COLUMN is_pinned; ALTER TABLE threads DROP COLUMN thread_section_id; DROP TABLE thread_sections; DROP TABLE thread_spawn_edges",
    );
    db.close();
    const result = await snapshot(home);
    expect(result.status).toBe("created");
    expect(result.metadata?.threads[0]).toMatchObject({
      id: "thread-1",
      title: "Fallback title",
      name: null,
      pinned: false,
      sectionId: null,
    });
    expect(result.metadata?.sections).toEqual([]);
    expect(result.metadata?.capabilities?.tables["projects"]).toBeUndefined();
    expect(result.metadata?.capabilities?.tables["threads"]).not.toContain("name");
  });

  it("reads native source/history/project/recency metadata and ordered roots without unrelated values", async () => {
    const home = await root();
    const db = createStateDatabase(join(home, "state_5.sqlite"));
    db.exec(`
      ALTER TABLE threads ADD COLUMN created_at_ms INTEGER;
      ALTER TABLE threads ADD COLUMN updated_at_ms INTEGER;
      ALTER TABLE threads ADD COLUMN recency_at_ms INTEGER;
      ALTER TABLE threads ADD COLUMN recency_at INTEGER;
      ALTER TABLE threads ADD COLUMN thread_source TEXT;
      ALTER TABLE threads ADD COLUMN history_mode TEXT;
      ALTER TABLE threads ADD COLUMN project_id TEXT;
      ALTER TABLE threads ADD COLUMN agent_path TEXT;
      ALTER TABLE threads ADD COLUMN originator TEXT;
      ALTER TABLE threads ADD COLUMN preview TEXT;
      ALTER TABLE threads ADD COLUMN creator_account_id TEXT;
      ALTER TABLE threads ADD COLUMN ephemeral INTEGER;
      UPDATE threads SET created_at_ms=100123, updated_at_ms=200456, recency_at_ms=150789, recency_at=150, thread_source='user', history_mode='paginated', project_id='native', agent_path='/root', originator='Codex Desktop', preview='A preview', creator_account_id='private-account', ephemeral=0;
      CREATE TABLE projects (id TEXT, name TEXT, metadata TEXT, position INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);
      INSERT INTO projects VALUES ('native', 'Native project', '{"appearance.color":"blue","appearance.marker":"star","accessToken":"must-not-leak"}', 4, 100, 200);
      CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
      INSERT INTO project_roots VALUES ('native', 9, 'C:/second'), ('native', 2, 'C:/first');
      CREATE TABLE thread_read_receipts (thread_id TEXT, first_unread_turn TEXT, revision TEXT, last_published_turn TEXT);
      INSERT INTO thread_read_receipts VALUES ('thread-1', 'turn-2', 'revision-1', 'turn-3');
      CREATE TABLE thread_attachments (id TEXT, thread_id TEXT, attachment_type TEXT, identity_key TEXT, payload TEXT, created_at INTEGER);
      INSERT INTO thread_attachments VALUES ('attachment-1','thread-1','pull_request','pr-1','{"url":"https://github.com/example/repo/pull/1","accessToken":"must-not-leak"}',300);
    `);
    db.close();
    const result = await snapshot(home);
    expect(result.status).toBe("created");
    expect(result.metadata?.threads[0]).toMatchObject({
      createdAtMs: 100123,
      updatedAtMs: 200456,
      recencyAtMs: 150789,
      recencyAt: 150,
      threadSource: "user",
      historyMode: "paginated",
      projectId: "native",
      agentPath: "/root",
      originator: "Codex Desktop",
      preview: "A preview",
      ephemeral: false,
    });
    expect(result.metadata?.projects).toEqual([
      {
        id: "native",
        name: "Native project",
        position: 4,
        createdAtMs: 100,
        updatedAtMs: 200,
        appearance: { color: "blue", marker: "star" },
        roots: [
          { position: 2, path: "C:/first" },
          { position: 9, path: "C:/second" },
        ],
      },
    ]);
    expect(result.metadata?.readReceipts).toEqual([
      {
        threadId: "thread-1",
        firstUnreadTurn: "turn-2",
        revision: "revision-1",
        lastPublishedTurn: "turn-3",
      },
    ]);
    expect(result.metadata?.attachments).toEqual([
      {
        id: "attachment-1",
        threadId: "thread-1",
        type: "pull_request",
        identityKey: "pr-1",
        createdAt: 300,
        reference: { url: "https://github.com/example/repo/pull/1" },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("private-account");
  });

  it("degrades malformed optional fields independently instead of rejecting valid threads", async () => {
    const home = await root();
    const db = createStateDatabase(join(home, "state_5.sqlite"));
    db.exec(
      "ALTER TABLE threads ADD COLUMN recency_at_ms TEXT; ALTER TABLE threads ADD COLUMN thread_source TEXT; UPDATE threads SET recency_at_ms='must-not-leak', thread_source='user'; CREATE TABLE projects (id TEXT)",
    );
    db.close();
    const result = await snapshot(home);
    expect(result.status).toBe("created");
    expect(result.metadata?.threads[0]).toMatchObject({ id: "thread-1", threadSource: "user" });
    expect(result.metadata?.threads[0]).not.toHaveProperty("recencyAtMs");
    expect(result.metadata?.projects).toEqual([]);
    expect(result.metadata?.capabilities?.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("keeps valid thread identity when optional legacy display values are malformed", async () => {
    const home = await root();
    const db = createStateDatabase(join(home, "state_5.sqlite"));
    db.exec("UPDATE threads SET name=7, is_pinned=9, thread_section_id=7");
    db.close();
    const result = await snapshot(home);
    expect(result.status).toBe("created");
    expect(result.metadata?.threads[0]).toMatchObject({ id: "thread-1", name: "7", pinned: false });
    expect(result.metadata?.capabilities?.diagnostics).toContainEqual({
      table: "threads",
      field: "pinned",
      reason: "invalid-field",
    });
  });
});

describe("independent JSON enrichment", () => {
  it("retains valid nested section, bookmark and host-map siblings in source order", async () => {
    const home = await root();
    const path = join(home, ".codex-global-state.json");
    await writeFile(
      path,
      JSON.stringify({
        "electron-persisted-atom-state": {
          "sidebar-custom-sections-v3": {
            account: {
              sections: [
                {
                  id: "first",
                  name: "First",
                  itemKeys: ["t1", 7, "t2"],
                  hostSectionIds: { local: "native-1", broken: 7, remote: "native-2" },
                },
                { id: "invalid", name: 7 },
                {
                  id: "last",
                  name: "Last",
                  pendingDeletionHostIdsByItemKey: { t1: ["local", 7, "remote"], invalid: 7 },
                },
              ],
              threadHostIds: { t1: "local", invalid: 7, t2: "remote" },
            },
          },
          "pinned-conversation-turns-v1": {
            account: {
              t1: [{ turnId: "turn-3" }, { turnId: 7 }, { turnId: "turn-1" }],
              invalid: 7,
              t2: [{ turnId: "turn-2" }],
            },
          },
        },
        "electron-thread-read-state-v1": {
          unreadByIdentity: { account: { local: ["t1", 7, "t2"], invalid: 7, remote: ["t3"] } },
        },
      }),
    );
    const result = await readGlobalState(path);
    expect(Object.values(result.metadata.sectionsByIdentity ?? {})).toEqual([
      {
        sections: [
          {
            id: "first",
            name: "First",
            itemKeys: ["t1", "t2"],
            hostSectionIds: { local: "native-1", remote: "native-2" },
          },
          {
            id: "last",
            name: "Last",
            pendingDeletionHostIdsByItemKey: { t1: ["local", "remote"] },
          },
        ],
        threadHostIds: { t1: "local", t2: "remote" },
      },
    ]);
    expect(Object.values(result.metadata.turnBookmarksByIdentity ?? {})).toEqual([
      { t1: [{ turnId: "turn-3" }, { turnId: "turn-1" }], t2: [{ turnId: "turn-2" }] },
    ]);
    expect(Object.values(result.metadata.unreadByIdentity ?? {})).toEqual([
      { local: ["t1", "t2"], remote: ["t3"] },
    ]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(
      result.diagnostics.every(({ details }) => !JSON.stringify(details).includes("turn-")),
    ).toBe(true);
  });

  it("keeps applied source strings, host section mappings, bookmarks and scoped unread evidence", async () => {
    const home = await root();
    const path = join(home, ".codex-global-state.json");
    await writeFile(
      path,
      JSON.stringify({
        "electron-persisted-atom-state": {
          "thread-workspace-state-v1:t1": {
            applied: {
              projectSources: ["C:/project"],
              cwd: "C:/project",
              runtimeWorkspaceRoots: ["C:/project"],
            },
          },
          "sidebar-custom-sections-v3": {
            "private-account": {
              sections: [
                {
                  id: "custom-1",
                  name: "Review",
                  itemKeys: ["codex:thread:local:t1"],
                  hostSectionIds: { local: "native-section" },
                },
              ],
              sectionOrder: ["custom:custom-1"],
              threadHostIds: { t1: "local" },
            },
          },
          "pinned-conversation-turns-v1": { "private-account": { t1: [{ turnId: "turn-2" }] } },
        },
        "electron-thread-read-state-v1": {
          unreadByIdentity: { "private-account": { local: ["t1"] } },
        },
      }),
    );
    const result = await readGlobalState(path);
    expect(result.metadata.workspaceStates?.["t1"]?.applied?.projectSources).toEqual([
      "C:/project",
    ]);
    expect(Object.values(result.metadata.sectionsByIdentity ?? {})[0]).toMatchObject({
      sections: [{ hostSectionIds: { local: "native-section" } }],
      threadHostIds: { t1: "local" },
    });
    expect(Object.values(result.metadata.turnBookmarksByIdentity ?? {})[0]).toEqual({
      t1: [{ turnId: "turn-2" }],
    });
    expect(Object.values(result.metadata.unreadByIdentity ?? {})[0]).toEqual({ local: ["t1"] });
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-account");
  });

  it("preserves project identity and other sidebar fields when optional timestamps or preferences are invalid", async () => {
    const home = await root();
    const path = join(home, ".codex-global-state.json");
    await writeFile(
      path,
      JSON.stringify({
        "local-projects": {
          p: { id: "p", name: "Project", rootPaths: [], createdAt: "must-not-leak", updatedAt: 25 },
        },
        "electron-persisted-atom-state": {
          "flat-project-sidebar-preferences-v1": {
            chatSortMode: "unknown",
            projectSortMode: "manual",
          },
        },
      }),
    );
    const result = await readGlobalState(path);
    expect(result.metadata.projects).toEqual([
      { id: "p", name: "Project", rootPaths: [], updatedAt: 25 },
    ]);
    expect(result.metadata.sidebarPreferences).toEqual({ projectSortMode: "manual" });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
  it("retains membership, opt-outs, host migrations and order beside an invalid project sibling", async () => {
    const home = await root();
    const path = join(home, ".codex-global-state.json");
    await writeFile(
      path,
      JSON.stringify({
        "local-projects": {
          valid: { id: "legacy", name: "Legacy", rootPaths: ["C:/repo"] },
          invalid: { id: 7 },
        },
        "thread-project-assignments": {
          t1: { projectKind: "local", projectId: "legacy" },
          broken: 4,
        },
        "projectless-thread-ids": ["t2", 8],
        "thread-project-membership-host-ids": { t1: "remote", t2: "local" },
        "app-server-project-id-by-legacy-project-id-by-host": {
          local: { legacy: "native" },
          remote: { legacy: "other-native" },
        },
        "sidebar-project-thread-orders": { legacy: { threadIds: ["t1", "stale"] } },
        "project-order": ["legacy", "other-native"],
        "electron-persisted-atom-state": {
          "flat-project-sidebar-preferences-v1": {
            sortOrder: "updated_at",
            showProjectChatsInRecents: false,
            accessToken: "must-not-leak",
          },
          "thread-descriptions-v1": { t1: "Description" },
          "thread-workspace-state-v1:t1": {
            revision: 2,
            project: { projectKind: "local", projectId: "legacy" },
            applied: {
              cwd: "C:/applied",
              runtimeWorkspaceRoots: ["C:/applied"],
              projectSources: [],
            },
            pending: { cwd: "C:/pending" },
          },
        },
        auth: { accessToken: "must-not-leak" },
      }),
    );
    const result = await readGlobalState(path);
    expect(result.metadata.projects).toEqual([
      { id: "legacy", name: "Legacy", rootPaths: ["C:/repo"] },
    ]);
    expect(result.metadata).toMatchObject({
      threadProjectAssignments: { t1: { projectKind: "local", projectId: "legacy" } },
      projectlessThreadIds: ["t2"],
      threadProjectMembershipHostIds: { t1: "remote", t2: "local" },
      projectIdByLegacyIdByHost: {
        local: { legacy: "native" },
        remote: { legacy: "other-native" },
      },
      projectThreadOrders: { legacy: ["t1", "stale"] },
      projectOrder: ["legacy", "other-native"],
      threadDescriptions: { t1: "Description" },
      workspaceStates: {
        t1: {
          revision: 2,
          project: { projectKind: "local", projectId: "legacy" },
          applied: { cwd: "C:/applied", runtimeWorkspaceRoots: ["C:/applied"], projectSources: [] },
        },
      },
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result.metadata.workspaceStates)).not.toContain("C:/pending");
  });
});

describe("metadata-only catalog facade", () => {
  it("retains authoritative root rows and provenance through root absence and corruption beside legacy state", async () => {
    const home = await root();
    const source = join(home, "state_5.sqlite");
    const db = createStateDatabase(source);
    db.close();
    await mkdir(join(home, "sqlite"));
    const legacy = createStateDatabase(join(home, "sqlite", "state_5.sqlite"));
    legacy.exec("UPDATE threads SET id='legacy-only'");
    legacy.close();
    const snapshots = join(home, "viewer");
    const { readCatalogMetadata } = await import("../../../server/metadata/catalogMetadata.ts");
    const first = await readCatalogMetadata(home, snapshots);
    expect(first.stateAuthority).toBe("root");
    expect(first.freshness.state).toBe("fresh");
    await rename(source, `${source}.moved`);
    const missing = await readCatalogMetadata(home, snapshots);
    expect(missing.threads.map(({ id }) => id)).toEqual(["thread-1"]);
    expect(missing.stateAuthority).toBe("root");
    expect(missing.freshness.state).toBe("retained");
    expect(missing.generations.state).toBe(first.generations.state);
    await writeFile(source, "invalid returning root");
    const invalid = await readCatalogMetadata(home, snapshots);
    expect(invalid.threads.map(({ id }) => id)).toEqual(["thread-1"]);
    expect(invalid.stateAuthority).toBe("root");
    expect(invalid.freshness.state).toBe("retained");
    expect(invalid.generations.state).toBe(first.generations.state);
  });

  it("does not relabel retained legacy rows as authoritative when a newly present root is corrupt", async () => {
    const home = await root();
    await mkdir(join(home, "sqlite"));
    const legacy = createStateDatabase(join(home, "sqlite", "state_5.sqlite"));
    legacy.exec("UPDATE threads SET id='legacy-only'");
    legacy.close();
    const snapshots = join(home, "viewer");
    const { readCatalogMetadata } = await import("../../../server/metadata/catalogMetadata.ts");
    const first = await readCatalogMetadata(home, snapshots);
    expect(first.threads.map(({ id }) => id)).toEqual(["legacy-only"]);
    expect(first.stateAuthority).toBe("legacy");
    expect(first.freshness.state).toBe("fresh");
    await writeFile(join(home, "state_5.sqlite"), "invalid current root");
    const invalid = await readCatalogMetadata(home, snapshots);
    expect(invalid.threads).toEqual([]);
    expect(invalid.stateAuthority).toBe("unavailable");
    expect(invalid.freshness.state).toBe("unavailable");
    expect(invalid.generations.state).toBeNull();
    expect(invalid.diagnostics.length).toBeGreaterThan(0);
  });

  it("does not retain another Codex home's catalog when a cache root is reused", async () => {
    const home = await root();
    const otherHome = await root();
    const { readCatalogMetadata } = await import("../../../server/metadata/catalogMetadata.ts");
    const db = createStateDatabase(join(home, "state_5.sqlite"));
    db.close();
    const snapshots = join(home, "viewer");
    expect((await readCatalogMetadata(home, snapshots)).threads).toHaveLength(1);
    const other = await readCatalogMetadata(otherHome, snapshots);
    expect(other.threads).toEqual([]);
    expect(other.freshness.state).toBe("unavailable");
  });

  it("discovers metadata without walking rollouts, keeps root authority and exposes retained freshness", async () => {
    const home = await root();
    const db = createStateDatabase(join(home, "state_5.sqlite"));
    db.close();
    await mkdir(join(home, "sqlite"));
    const legacy = createStateDatabase(join(home, "sqlite", "state_5.sqlite"));
    legacy.exec("UPDATE threads SET id='legacy-only'");
    legacy.close();
    // Files in place of directories make an accidental rollout traversal observable
    await writeFile(join(home, "sessions"), "not a directory");
    await writeFile(join(home, "archived_sessions"), "not a directory");
    const before = await readdir(home);
    const discovery = await discoverMetadataSources(home);
    expect(discovery.metadata.stateDatabase).toBe(join(home, "state_5.sqlite"));
    expect(discovery.metadata.legacyStateDatabase).toBe(join(home, "sqlite", "state_5.sqlite"));
    const { readCatalogMetadata } = await import("../../../server/metadata/catalogMetadata.ts");
    const result = await readCatalogMetadata(home, join(home, "viewer"));
    expect(result.threads.map(({ id }) => id)).toEqual(["thread-1"]);
    expect(result.freshness.state).toBe("fresh");
    expect(result.diagnostics).toEqual([]);
    await writeFile(join(home, "state_5.sqlite"), "corrupt");
    const retained = await readCatalogMetadata(home, join(home, "viewer"));
    expect(retained.freshness.state).toBe("retained");
    expect(retained.threads.map(({ id }) => id)).toEqual(["thread-1"]);
    expect(retained.generations.state).toEqual(result.generations.state);
    expect((await readdir(home)).filter((name) => name !== "viewer")).toEqual(before);
    expect(await readdir(join(home, "sqlite"))).toEqual(["state_5.sqlite"]);
  });

  it("honors cancellation before touching an unavailable source home", async () => {
    const { readCatalogMetadata } = await import("../../../server/metadata/catalogMetadata.ts");
    const controller = new AbortController();
    controller.abort();
    await expect(
      readCatalogMetadata("does-not-exist", "does-not-exist", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
