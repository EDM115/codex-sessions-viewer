import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { expect, it } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import { SessionCacheUpdater } from "#server/cache/sourceManifest.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import { selectSessionSources } from "#server/ingestion/selectSessionSources.ts";
import { observeSessionMetaSource } from "#server/ingestion/sessionMetaPrefix.ts";

const id = "12345678-1234-4234-8234-123456789abc";

it.each([
  "valid",
  "wrong-identity",
  "plain-sibling",
  "unrelated-plain",
  "ambiguous-owner",
  "plain-missing-prefix",
  "plain-missing-wrong-identity",
  "warm-missing-wrong-identity",
])("verifies declared identity for short filenames (%s)", async (condition) => {
  const root = await mkdtemp(join(tmpdir(), "short-zstd-"));
  const home = join(root, "home");
  const missingPrefix = condition.includes("missing");
  const wrongIdentity = condition.includes("wrong-identity");
  const path = join(home, `sessions/short.jsonl${missingPrefix ? "" : ".zst"}`);
  await mkdir(join(home, "sessions"), { recursive: true });
  const payload = (thread: string) =>
    JSON.stringify({ type: "session_meta", payload: { id: thread } }) + "\n";
  const sourceBytes = Buffer.from(payload(wrongIdentity ? "foreign" : id));
  await writeFile(path, missingPrefix ? sourceBytes : zstdCompressSync(sourceBytes));
  const candidates = [{ path, scope: "active" as const }];
  if (condition === "plain-sibling") {
    await writeFile(path.slice(0, -4), payload(id));
    candidates.push({ path: path.slice(0, -4), scope: "active" });
  }
  if (condition === "unrelated-plain") {
    const unrelated = join(home, `sessions/rollout-2026-10-31T10-00-00-${id}.jsonl`);
    await writeFile(unrelated, payload(id));
    candidates.push({ path: unrelated, scope: "active" });
  }
  const database = openCacheDatabase(":memory:");
  const store = new RolloutStore({ cacheDirectory: join(root, "decoded") });
  const updater = new SessionCacheUpdater(database, {
    openRollout: (ref, signal) => store.open(ref, signal),
  });
  try {
    const warm = condition.startsWith("warm-");
    const warmed = warm ? await updater.update({ path, scope: "active" }) : null;
    expect(warmed?.status ?? null).toBe(warm ? "updated" : null);
    expect(warmed && "sessionId" in warmed ? warmed.sessionId : null).toBe(warm ? "foreign" : null);
    const selected = await selectSessionSources(candidates, {
      codexHome: home,
      ...(missingPrefix
        ? {
            readPrefix: async (sourcePath: string) => ({
              status: "missing" as const,
              meta: null,
              parentThreadIdHint: null,
              bytesRead: 0,
              observation: await observeSessionMetaSource(sourcePath),
              diagnostics: [],
            }),
          }
        : {}),
      currentRolloutPaths: new Map([
        [id, missingPrefix ? "sessions/short.jsonl" : "sessions/short.jsonl.zst"],
        ...(condition === "ambiguous-owner"
          ? [["foreign", "sessions/short.jsonl.zst"] as [string, string]]
          : []),
      ]),
    });
    const ambiguous = condition === "ambiguous-owner";
    expect(selected.selected).toHaveLength(ambiguous ? 0 : 1);
    expect(
      selected.diagnostics.filter(
        (diagnostic) => diagnostic.code === "source.current_rollout_unresolved",
      ),
    ).toHaveLength(ambiguous ? 2 : 0);
    expect(selected.selected[0]?.source.path).toBe(
      ambiguous ? undefined : condition === "plain-sibling" ? path.slice(0, -4) : path,
    );
    const selectedSource = selected.selected[0]?.source;
    const updated = selectedSource ? await updater.update(selectedSource) : null;
    expect(updated?.status ?? null).toBe(ambiguous ? null : wrongIdentity ? "failed" : "updated");
  } finally {
    updater.clear();
    await store.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["relative", "absolute", "compressed-pointer"])(
  "resolves a metadata-identified noncanonical native reference against its selected home (%s)",
  async (reference) => {
    const home = await mkdtemp(join(tmpdir(), "viewer-current-source-"));
    const relative = `sessions/rollout-${id}.jsonl`;
    const path = join(home, relative);
    try {
      expect(process.cwd()).not.toBe(home);
      await mkdir(join(home, "sessions"));
      await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
      const result = await selectSessionSources([{ path, scope: "active" }], {
        codexHome: home,
        currentRolloutPaths: new Map([
          [
            id,
            reference === "relative" ? relative : reference === "absolute" ? path : `${path}.zst`,
          ],
        ]),
      });
      expect(result.selected.map(({ source }) => source.path)).toEqual([path]);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32").each(["plain", "compressed-pointer"])(
  "selects the same Windows file through a differently cased native reference (%s)",
  async (representation) => {
    const home = await mkdtemp(join(tmpdir(), "viewer-current-case-"));
    const path = join(home, `sessions/rollout-2026-10-31T10-00-00-${id}.jsonl`);
    const casePath = path.toUpperCase();
    try {
      await mkdir(join(home, "sessions"));
      await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
      const [sourceStat, pointerStat] = await Promise.all([
        stat(path, { bigint: true }),
        stat(casePath, { bigint: true }),
      ]);
      expect(pointerStat.ino).toBe(sourceStat.ino);
      expect(pointerStat.dev).toBe(sourceStat.dev);
      const result = await selectSessionSources([{ path, scope: "active" }], {
        codexHome: home,
        currentRolloutPaths: new Map([
          [id, representation === "plain" ? casePath : `${casePath}.ZST`],
        ]),
      });
      expect(result.selected.map(({ source }) => source.path)).toEqual([path]);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("refuses a distinct existing source even when its canonical filename carries the same physical ID", async () => {
  const home = await mkdtemp(join(tmpdir(), "viewer-current-distinct-"));
  const path = join(home, `sessions/rollout-2026-10-31T10-00-00-${id}.jsonl`);
  const declared = join(home, `sessions/rollout-2026-10-31T11-00-00-${id}.jsonl`);
  try {
    await mkdir(join(home, "sessions"));
    await Promise.all(
      [path, declared].map((source) =>
        writeFile(source, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n"),
      ),
    );
    const [sourceStat, pointerStat] = await Promise.all([
      stat(path, { bigint: true }),
      stat(declared, { bigint: true }),
    ]);
    expect(pointerStat.ino).not.toBe(sourceStat.ino);
    const result = await selectSessionSources([{ path, scope: "active" }], {
      codexHome: home,
      currentRolloutPaths: new Map([[id, declared]]),
    });
    expect(result.selected).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      {
        code: "source.current_rollout_unresolved",
        sessionId: id,
        path: declared,
        details: { reason: "missing" },
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")(
  "keeps differently cased Linux filenames distinct",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "viewer-current-linux-case-"));
    const name = `rollout-2026-10-31T10-00-00-${id}.jsonl`;
    const path = join(home, "sessions", name);
    const declared = join(home, "sessions", name.toUpperCase());
    try {
      await mkdir(join(home, "sessions"));
      await Promise.all(
        [path, declared].map((source) =>
          writeFile(source, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n"),
        ),
      );
      const [sourceStat, pointerStat] = await Promise.all([
        stat(path, { bigint: true }),
        stat(declared, { bigint: true }),
      ]);
      expect(pointerStat.ino).not.toBe(sourceStat.ino);
      const result = await selectSessionSources([{ path, scope: "active" }], {
        codexHome: home,
        currentRolloutPaths: new Map([[id, declared]]),
      });
      expect(result.selected).toEqual([]);
      expect(result.diagnostics).toMatchObject([
        { code: "source.current_rollout_unresolved", details: { reason: "missing" } },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("qualifies each missing, ambiguous and outside-root declared reference without selecting an arbitrary leaf", async () => {
  const home = await mkdtemp(join(tmpdir(), "viewer-unresolved-source-"));
  try {
    await mkdir(join(home, "sessions"));
    const paths = [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ].map((physical) => join(home, `sessions/rollout-2026-10-31T10-00-00-${id}_${physical}.jsonl`));
    await Promise.all(
      paths.map((path) =>
        writeFile(path, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n"),
      ),
    );
    const currentRolloutPaths = new Map([
      [id, "sessions/missing.jsonl"],
      ["missing-thread", "sessions/absent.jsonl"],
      ["outside-thread", "../outside.jsonl"],
    ]);
    const result = await selectSessionSources(
      paths.map((path) => ({ path, scope: "active" as const })),
      { codexHome: home, currentRolloutPaths },
    );
    expect(result.selected).toEqual([]);
    expect(
      result.diagnostics.map(({ code, sessionId, path, details }) => ({
        code,
        sessionId,
        path,
        reason: details["reason"],
      })),
    ).toEqual([
      {
        code: "source.current_rollout_unresolved",
        sessionId: id,
        path: join(home, "sessions/missing.jsonl"),
        reason: "ambiguous",
      },
      {
        code: "source.current_rollout_unresolved",
        sessionId: "missing-thread",
        path: join(home, "sessions/absent.jsonl"),
        reason: "missing",
      },
      {
        code: "source.current_rollout_unresolved",
        sessionId: "outside-thread",
        path: join(home, "../outside.jsonl"),
        reason: "outside-root",
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
