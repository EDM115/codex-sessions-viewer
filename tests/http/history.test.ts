import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  appendFile,
  glob,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { setup, $fetch, url, createPage, useTestContext } from "@nuxt/test-utils/e2e";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CachedContentFile } from "#server/cache/contentStore.ts";
import { rolloutRefFromSource } from "#server/ingestion/rolloutIdentity.ts";
import { mergeHistoryWindows } from "#shared/timeline/history.ts";
import { LiveApiConversationRepository } from "~/repositories/live.ts";

import { canonicalRecords } from "../fixtures/history/nativeHistory.ts";
import { cutoffReviewRecords, parentReviewRecords } from "../fixtures/history/parentReviews.ts";
import { createStateDatabase } from "../integration/source-boundary/fixtures.ts";

const httpRoot = await mkdtemp(join(tmpdir(), "viewer-nuxt-http-"));
await setup({
  rootDir: resolve("tests/fixtures/nuxt-history"),
  dev: false,
  browser: true,
  env: { VIEWER_TEST_ROOT: httpRoot },
  setupTimeout: 240000,
});
let fixtureOrigin = "";
beforeAll(() => {
  fixtureOrigin = url("/");
});
afterEach(async () => {
  if (fixtureOrigin) {
    await fetch(new URL("api/__fixture/control", fixtureOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "close" }),
    });
  }
});
afterAll(async () => {
  await rm(httpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function fixture(
  options: {
    compressed?: boolean;
    records?: unknown[];
    configureState?: (database: DatabaseSync) => void;
  } = {},
) {
  const root = await mkdtemp(join(httpRoot, "case-"));
  const home = join(root, "home");
  await mkdir(join(home, "sessions"), { recursive: true });
  const path = join(home, `sessions/rollout-thread-1.jsonl${options.compressed ? ".zst" : ""}`);
  const text =
    (options.records ?? canonicalRecords())
      .map((record) => JSON.stringify(record).replaceAll('"stable"', '"thread-1"'))
      .join("\n") + "\n";
  await writeFile(path, options.compressed ? zstdCompressSync(Buffer.from(text)) : text);
  const state = createStateDatabase(join(home, "state_5.sqlite"));
  if (options.compressed) {
    state.exec("UPDATE threads SET rollout_path = 'sessions/rollout-thread-1.jsonl.zst'");
  }
  options.configureState?.(state);
  state.close();
  await $fetch("/api/__fixture/control", { method: "POST", body: { action: "reset", root } });
  return { root, home, path };
}
const snapshot = () =>
  $fetch<{
    fullReads: number;
    rolloutOpens: number;
    rolloutIo: number;
    requestedBytes: number;
    sessions: number;
    authority: unknown[];
    status: { state: string; catalogSource: string; recoveryState: string };
    events: Array<{ type: string; ids: string[]; groupsChanged?: boolean }>;
    listeners: number;
    decoderChunks: number;
    abortedOpens: number;
    gate: { entered: boolean; aborted: boolean } | null;
  }>("/api/__fixture/control", { method: "POST", body: { action: "snapshot" } });
const client = new LiveApiConversationRepository(async (path, options = {}) => {
  const response = await fetch(url(path), {
    method: options.method,
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
});
async function contentResponse(root: string, file: CachedContentFile | null) {
  await $fetch("/api/__fixture/control", {
    method: "POST",
    body: { action: "content", root, file },
  });
  return fetch(url("/api/__fixture/content"));
}
async function validatedQuery(query: string, kind: "list" | "turn" | "search") {
  const response = await fetch(url(`/api/__fixture/validate?kind=${kind}&${query}`));
  return { body: await response.json(), status: response.status };
}
describe("actual Nuxt progressive HTTP routes", () => {
  it("resolves a direct target through bounded preparation without walking every earlier history page", async () => {
    const records: unknown[] = canonicalRecords();
    records.splice(
      1,
      0,
      ...Array.from({ length: 1500 }, () => ({
        type: "token_usage",
        payload: { padding: "p".repeat(500) },
      })),
    );
    const newer: unknown[] = canonicalRecords("NEWER")
      .slice(1)
      .map((record) =>
        JSON.parse(
          JSON.stringify(record)
            .replaceAll('"turn"', '"newer"')
            .replaceAll('"user"', '"new-user"')
            .replaceAll('"answer"', '"new-answer"'),
        ),
      );
    newer.splice(
      2,
      0,
      ...Array.from({ length: 5000 }, (_, index) => ({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "newer",
          item: {
            type: "AgentMessage",
            id: `newer-${index}`,
            content: [{ type: "Text", text: "x".repeat(160) }],
          },
        },
      })),
    );
    records.push(...newer);
    await fixture({ records });
    const target = await client.getHistoryPage("thread-1", {
      anchor: { kind: "turn", turnId: "turn" },
      limit: 5,
    });
    let window = target.turns.find((entry) => entry.turnId === "turn");
    expect(window).toBeDefined();
    for (let index = 0; window?.opening.availability !== "available" && index < 6; index += 1) {
      if (!window?.preparation?.cursor) {
        throw new Error("Expected bounded target preparation cursor");
      }
      // oxlint-disable-next-line no-await-in-loop -- Direct target discovery advances its dedicated cursor without older turn-page scans
      window = await client.getTurnItems("thread-1", {
        turnId: "turn",
        anchor: { kind: "after", cursor: window.preparation.cursor },
      });
    }
    expect(window?.opening.item).toMatchObject({ id: "user", text: "question" });
    expect(await snapshot()).toMatchObject({ fullReads: 0, sessions: 0 });
  });
  it("rejects an older in-flight page across a live append, then retains its identities while recovering the updated older item", async () => {
    const records = canonicalRecords();
    const middle = Array.from({ length: 2000 }, (_, index) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: {
          type: "AgentMessage",
          id: `update-${index}`,
          content: [{ type: "Text", text: `original-${index}-${"x".repeat(80)}` }],
        },
      },
    }));
    records.splice(3, 0, ...middle);
    const f = await fixture({ records });
    const first = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
    const original = await readFile(f.path, "utf8");
    const expectedPosition = Buffer.byteLength(
      original.slice(0, original.indexOf(JSON.stringify(middle[1850]))),
    );
    const firstTurn = first.turns[0];
    if (!firstTurn?.beforeCursor) {
      throw new Error("Expected the first turn boundary");
    }
    const oldCursor = firstTurn.beforeCursor;
    const query = {
      turnId: "turn",
      anchor: { kind: "before", cursor: oldCursor },
      limit: 100,
    } as const;
    const previouslyLoaded = await client.getTurnItems("thread-1", query);
    const oldText = middle[1850]?.payload.item.content[0]?.text;
    if (!oldText) {
      throw new Error("Expected the original older item fixture");
    }
    expect(previouslyLoaded.items.find((item) => item.itemId === "update-1850")).toMatchObject({
      detail: "full",
      item: { text: oldText },
    });
    const loadedBeforeAppend = mergeHistoryWindows(first.turns, [previouslyLoaded]);
    await $fetch("/api/__fixture/control", {
      method: "POST",
      body: { action: "gate", enabled: true },
    });
    const pending = fetch(
      url(`/api/sessions/thread-1/items?history=${encodeURIComponent(JSON.stringify(query))}`),
    );
    await vi.waitFor(async () => expect((await snapshot()).gate?.entered).toBe(true));
    await appendFile(
      f.path,
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn",
          item: {
            type: "AgentMessage",
            id: "update-1850",
            content: [{ type: "Text", text: "UPDATED OLDER ITEM" }],
          },
        },
      }) + "\n",
    );
    await $fetch("/api/__fixture/control", {
      method: "POST",
      body: { action: "gate", enabled: false },
    });
    expect((await pending).status).toBe(409);
    const current = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
    expect(current.historyEpoch).toBe(first.historyEpoch);
    expect(
      current.turns.flatMap((turn) => turn.items).some((item) => item.itemId === "update-1850"),
    ).toBe(false);
    const retained = mergeHistoryWindows(loadedBeforeAppend, current.turns);
    expect(retained[0]?.items.find((item) => item.itemId === "update-1850")).toMatchObject({
      detail: "unresolved",
      decodedByteStart: expectedPosition,
      item: { text: oldText },
    });
    const older = await client.getTurnItems("thread-1", query);
    const updated = older.items.find((item) => item.itemId === "update-1850");
    expect(updated?.item).toMatchObject({ text: "UPDATED OLDER ITEM" });
    expect(updated?.decodedByteStart).toBe(expectedPosition);
    expect(updated?.updatedAtDecodedByte).toBe(Buffer.byteLength(original));
    expect(older.items.filter((item) => item.itemId === "update-1850")).toHaveLength(1);
    expect(
      mergeHistoryWindows(retained, [older])[0]?.items.find(
        (item) => item.itemId === "update-1850",
      ),
    ).toMatchObject({
      detail: "full",
      decodedByteStart: expectedPosition,
      item: { text: "UPDATED OLDER ITEM" },
    });
    expect((await snapshot()).sessions).toBe(0);
    expect((await snapshot()).fullReads).toBe(0);
    expect(
      firstTurn.items.every((item) =>
        mergeHistoryWindows(first.turns, [older])[0]?.items.some(
          (loaded) => loaded.itemId === item.itemId,
        ),
      ),
    ).toBe(true);
  });
  it("serves concurrent cold catalog requests and WAL/atomic metadata updates without rollout preparation", async () => {
    const f = await fixture({
      configureState(database) {
        database.exec(
          "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT); INSERT INTO projects VALUES ('native:section-1', 'Native project sharing a section ID'), ('none', 'Native project named none'); ALTER TABLE threads ADD COLUMN project_id TEXT",
        );
        const cloned = {
          ...database.prepare("SELECT * FROM threads LIMIT 1").get(),
          id: "native-none",
          rollout_path: "sessions/native-none.jsonl",
          updated_at: 100,
          is_pinned: 0,
          thread_section_id: null,
          project_id: "none",
          name: "Native none",
        };
        database
          .prepare(
            `INSERT INTO threads (${Object.keys(cloned).join(",")}) VALUES (${Object.keys(cloned)
              .map(() => "?")
              .join(",")})`,
          )
          .run(...Object.values(cloned));
      },
    });
    const responses = await Promise.all([
      fetch(url("/api/sessions?scope=active&limit=1")),
      fetch(url("/api/projects")),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const page = await responses[0].json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: "thread-1", title: "Chosen name" });
    expect((await snapshot()).status).toMatchObject({
      state: "ready",
      catalogSource: "fresh",
      recoveryState: "idle",
    });
    const groups = await client.listProjects();
    expect(groups.map((group) => group.groupId)).toEqual(
      expect.arrayContaining([
        "project:native%3Asection-1",
        "section:native%3Asection-1",
        "project:none",
        "recents:none",
      ]),
    );
    expect((await client.listSessions({ scope: "active" })).total).toBe(2);
    expect(
      (await client.listSessions({ scope: "active", projectId: null })).items.map(
        (entry) => entry.id,
      ),
    ).toEqual(["thread-1"]);
    expect(
      (await client.listSessions({ scope: "active", projectId: "none" })).items.map(
        (entry) => entry.id,
      ),
    ).toEqual(["native-none"]);
    expect(
      (await client.listSessions({ scope: "active", projectId: "native:section-1" })).total,
    ).toBe(0);
    expect(
      (
        await client.listSessions({ scope: "active", groupId: "section:native%3Asection-1" })
      ).items.map((entry) => entry.id),
    ).toEqual(["thread-1"]);
    expect((await client.listSessions({ scope: "active", groupId: "recents:none" })).total).toBe(0);
    await Promise.all(
      groups.map(async (group) =>
        expect(
          (
            await fetch(
              url(
                `/api/sessions?scope=active&groupId=${encodeURIComponent(group.groupId)}&limit=1`,
              ),
            )
          ).status,
        ).toBe(200),
      ),
    );
    expect((await fetch(url("/api/sessions?scope=active&limit=bad"))).status).toBe(400);
    const hostResponse = (host: string) =>
      new Promise<{ status: number | undefined; body: string }>((settle, reject) => {
        const outgoing = request(url("/api/projects"), { headers: { Host: host } }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => settle({ status: response.statusCode, body }));
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
    const rejectedByViewer = await hostResponse("external.example");
    expect(rejectedByViewer.status).toBe(421);
    expect(rejectedByViewer.body).toContain("Loopback access only");
    expect(
      (
        await fetch(url("/api/sessions/prepare"), {
          method: "POST",
          headers: { Origin: "https://external.example", "Content-Type": "application/json" },
          body: '{"ids":["thread-1"]}',
        })
      ).status,
    ).toBe(403);
    const writer = new DatabaseSync(join(f.home, "state_5.sqlite"));
    try {
      writer.exec("PRAGMA journal_mode=WAL; UPDATE threads SET name='WAL title'");
      await vi.waitFor(async () =>
        expect((await client.listSessions({ scope: "active" })).items[0]?.title).toBe("WAL title"),
      );
    } finally {
      writer.close();
    }
    const eventCount = (await snapshot()).events.length;
    await writeFile(
      join(f.home, ".codex-global-state.json.tmp"),
      JSON.stringify({ "pinned-thread-ids": ["thread-1"] }),
    );
    await rename(
      join(f.home, ".codex-global-state.json.tmp"),
      join(f.home, ".codex-global-state.json"),
    );
    await vi.waitFor(async () =>
      expect((await snapshot()).events.slice(eventCount).some((event) => event.groupsChanged)).toBe(
        true,
      ),
    );
    expect(await snapshot()).toMatchObject({
      fullReads: 0,
      rolloutOpens: 0,
      rolloutIo: 0,
      sessions: 0,
    });
  });
  it("cancels a real selected Zstd decoder after client disconnect and releases ownership for retry", async () => {
    const records = canonicalRecords();
    records.splice(
      3,
      0,
      ...Array.from({ length: 30000 }, (_, index) => ({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn",
          item: {
            type: "AgentMessage",
            id: `large-${index}`,
            content: [{ type: "Text", text: `payload-${index}-${"x".repeat(400)}` }],
          },
        },
      })),
    );
    const f = await fixture({ compressed: true, records });
    const source = await readFile(f.path);
    const pending = request(url("/api/sessions/thread-1/turns"));
    pending.on("error", () => undefined);
    pending.end();
    await vi.waitFor(async () => expect((await snapshot()).decoderChunks).toBeGreaterThan(0));
    pending.destroy();
    await vi.waitFor(async () => expect((await snapshot()).abortedOpens).toBeGreaterThan(0));
    const retried = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
    expect(retried.turns.at(-1)?.items.at(-1)?.item).toMatchObject({ text: "answer A" });
    expect(await readFile(f.path)).toEqual(source);
    expect((await snapshot()).fullReads).toBe(0);
  });
  it("delivers invalidation frames through Nuxt and releases its subscriber on disconnect", async () => {
    await fixture();
    await client.getSessionMetadata("thread-1");
    const baseline = (await snapshot()).listeners;
    const abort = new AbortController();
    const pending = fetch(url("/api/events"), { signal: abort.signal });
    try {
      await vi.waitFor(async () => expect((await snapshot()).listeners).toBe(baseline + 1));
      const event = {
        type: "session.updated",
        ids: ["session-1", "turn-2"],
        revision: "sha256:transport",
      };
      await $fetch("/api/__fixture/control", {
        method: "POST",
        body: { action: "publish", event },
      });
      const response = await pending;
      const chunk = await response.body?.getReader().read();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frame = new TextDecoder().decode(chunk?.value);
      expect(frame).toContain("event: session.updated");
      expect(frame).toContain("id: sha256:transport");
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      expect(JSON.parse(data!.slice(6))).toEqual(event);
    } finally {
      abort.abort();
      await pending.catch(() => undefined);
    }
    await vi.waitFor(async () => expect((await snapshot()).listeners).toBe(baseline));
  });
  it("serves metadata and latest history without full materialization", async () => {
    await fixture();
    expect(await $fetch("/api/sessions/thread-1")).toMatchObject({ title: "Chosen name" });
    const before = await snapshot();
    expect(before.rolloutOpens).toBe(0);
    expect(before.rolloutIo).toBe(0);
    const page = await $fetch<{ turns: Array<{ items: Array<{ itemId: string }> }> }>(
      "/api/sessions/thread-1/turns",
    );
    expect(page.turns[0]?.items.map((item) => item.itemId)).toEqual(["user", "answer"]);
    expect((await snapshot()).fullReads).toBe(0);
    expect((await snapshot()).rolloutIo).toBeGreaterThan(0);
  });
  it("opens the real progressive Info control against cache-empty Nuxt history without legacy materialization", async () => {
    const stageStarted = performance.now();
    const stages: Record<string, unknown> = {};
    const output = useTestContext().nuxt?.options.nitro.output?.dir;
    if (!output) {
      throw new Error("Expected the actual built Nuxt output");
    }
    const clientScripts = await Array.fromAsync(glob("**/*.js", { cwd: join(output, "public") }));
    const serverScripts = await Array.fromAsync(glob("**/*.mjs", { cwd: join(output, "server") }));
    let scannedScriptCharacters = 0;
    async function containsSqlite(path: string): Promise<boolean> {
      let suffix = "";
      for await (const chunk of createReadStream(path, {
        encoding: "utf8",
        highWaterMark: 64 * 1024,
      })) {
        const text = String(chunk);
        scannedScriptCharacters += text.length;
        const search = suffix + text;
        if (search.includes("node:sqlite")) {
          return true;
        }
        suffix = search.slice(-10);
      }
      return false;
    }
    let clientHasSqlite = false;
    for (const file of clientScripts) {
      // oxlint-disable-next-line no-await-in-loop -- Inspect every client file with one bounded stream instead of retaining the complete script graph
      if (await containsSqlite(join(output, "public", file))) {
        clientHasSqlite = true;
        break;
      }
    }
    let serverHasSqlite = false;
    for (const file of serverScripts) {
      // oxlint-disable-next-line no-await-in-loop -- One positive server dependency proves the retained packaging assertion
      if (await containsSqlite(join(output, "server", file))) {
        serverHasSqlite = true;
        break;
      }
    }
    expect(clientScripts.length).toBeGreaterThan(0);
    expect(clientHasSqlite).toBe(false);
    expect(serverHasSqlite).toBe(true);
    stages["packagingMs"] = performance.now() - stageStarted;
    stages["afterPackagingMemory"] = process.memoryUsage();
    stages["packagingScan"] = {
      clientFiles: clientScripts.length,
      serverFiles: serverScripts.length,
      scannedScriptCharacters,
      wholeScriptStringsRetained: 0,
      streamHighWaterMark: 64 * 1024,
      carryCharacters: 10,
    };
    const records = canonicalRecords();
    records.splice(3, 0, {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: {
          type: "CommandExecution",
          id: "inspect-command",
          command: ["echo", "inspect"],
          cwd: "/fixture",
          parsed_cmd: [],
          source: "agent",
          status: "completed",
          aggregated_output: "INSPECT COMMAND OUTPUT",
          exit_code: 0,
          duration: { secs: 1, nanos: 0 },
        },
      },
    });
    const fixtureStarted = performance.now();
    const selected = await fixture({ records });
    stages["fixtureMs"] = performance.now() - fixtureStarted;
    const pageStarted = performance.now();
    const page = await createPage("/");
    stages["pageCreationMs"] = performance.now() - pageStarted;
    const interactionStarted = performance.now();
    try {
      await page.getByRole("button", { name: "Open message info", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible" });
      expect(await dialog.textContent()).toContain("History epoch");
      expect(await dialog.textContent()).toContain("thread-1");
      expect(await dialog.textContent()).toContain("Unavailable");
      await dialog.locator("summary").click();
      await dialog.locator(".conversation-raw > summary").click();
      await vi.waitFor(async () => expect(await dialog.textContent()).toContain("answer A"));
      await page.getByRole("button", { name: "Close message info", exact: true }).click();
      await page.locator(".conversation-work-stream > summary").click();
      await page.locator(".conversation-tool-group > summary").click();
      await page.locator(".conversation-tool-row summary").click();
      await page.getByRole("button", { name: "Info", exact: true }).click();
      expect(await dialog.textContent()).toContain("activity · inspect-command");
      await dialog.locator("summary").click();
      await dialog.locator(".conversation-raw > summary").click();
      await vi.waitFor(async () =>
        expect(await dialog.textContent()).toContain("INSPECT COMMAND OUTPUT"),
      );
      await appendFile(
        selected.path,
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "turn",
            item: {
              type: "AgentMessage",
              id: "answer",
              content: [{ type: "Text", text: "answer B" }],
              phase: "final_answer",
            },
          },
        }) + "\n",
      );
      await $fetch("/api/__fixture/control", {
        method: "POST",
        body: {
          action: "publish",
          event: { type: "session.updated", ids: ["thread-1"], revision: "updated-answer" },
        },
      });
      await dialog.waitFor({ state: "hidden" });
      await page.getByText("answer B", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Open message info", exact: true }).click();
      await dialog.locator("summary").click();
      await dialog.locator(".conversation-raw > summary").click();
      await vi.waitFor(async () => expect(await dialog.textContent()).toContain("answer B"));
      expect(await dialog.textContent()).not.toContain("answer A");
      expect((await snapshot()).sessions).toBe(0);
      expect((await snapshot()).fullReads).toBe(0);
    } finally {
      stages["interactionsMs"] = performance.now() - interactionStarted;
      await page.close();
      stages["totalMs"] = performance.now() - stageStarted;
      console.log(JSON.stringify({ condition: "progressive-info-stage-costs", stages }));
      if (process.env["VIEWER_INFO_METRICS_OUTPUT"]) {
        await writeFile(
          resolve(process.env["VIEWER_INFO_METRICS_OUTPUT"]),
          JSON.stringify({ condition: "progressive-info-stage-costs", stages }, null, 2),
        );
      }
    }
  });
  it("propagates an actual Nuxt socket disconnect to a pending selected source read", async () => {
    await fixture();
    await $fetch("/api/__fixture/control", {
      method: "POST",
      body: { action: "gate", enabled: true },
    });
    const pending = request(url("/api/sessions/thread-1/turns"));
    pending.on("error", () => undefined);
    pending.end();
    await vi.waitFor(async () => expect((await snapshot()).gate?.entered).toBe(true));
    pending.destroy();
    await vi.waitFor(async () => expect((await snapshot()).gate?.aborted).toBe(true));
    await $fetch("/api/__fixture/control", {
      method: "POST",
      body: { action: "gate", enabled: false },
    });
  });
  it.each(["empty", "corrupt"])(
    "keeps metadata independent of an %s source without inventing complete coverage",
    async (kind) => {
      const f = await fixture();
      await writeFile(
        f.path,
        kind === "empty"
          ? JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }) + "\n"
          : "broken source\n",
      );
      expect((await client.getSessionMetadata("thread-1")).title).toBe("Chosen name");
      const page = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
      expect(page.turns).toEqual([]);
      expect(page.coverage.status).toBe(kind === "empty" ? "complete" : "unresolved");
      expect((await snapshot()).fullReads).toBe(0);
    },
  );
  it("loads items and independent navigator coverage, rejects forged cursors recoverably and retains catalog placement after body loss", async () => {
    const f = await fixture();
    const metadata = await client.getSessionMetadata("thread-1");
    expect(metadata).not.toHaveProperty("turnCount");
    const page = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
    expect(page.turns[0]?.items.map((item) => item.itemId)).toEqual(["user", "answer"]);
    const opening = await client.getTurnItems("thread-1", {
      turnId: "turn",
      anchor: { kind: "opening" },
      limit: 2,
    });
    expect(opening.opening.item).toMatchObject({ id: "user", text: "question" });
    const navigation = await client.getHistoryNavigator("thread-1", {
      anchor: { kind: "latest" },
      limit: 5,
    });
    expect(navigation.turns[0]?.turnId).toBe("turn");
    expect(navigation.turns[0]).not.toHaveProperty("items");
    const invalid = await fetch(
      url(
        `/api/sessions/thread-1/items?history=${encodeURIComponent(JSON.stringify({ turnId: "turn", anchor: { kind: "before", cursor: "forged" } }))}`,
      ),
    );
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({
      data: { code: "history.reload_required", recoverable: true },
    });
    const groups = await client.listProjects();
    await rm(f.path);
    const unavailable = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
    expect(unavailable.preparation).toBe("unavailable");
    expect(await client.getSessionMetadata("thread-1")).toEqual(metadata);
    expect(await client.listProjects()).toEqual(groups);
    expect(await snapshot()).toMatchObject({ fullReads: 0, sessions: 0 });
  });
  it("keeps pure rich formatting outside history authority", async () => {
    await fixture();
    const page = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
    const authority = (await snapshot()).authority;
    const turn = page.turns[0];
    if (!turn) {
      throw new Error("Expected a loaded turn");
    }
    const prepared = await client.prepareHistoryPresentation({
      threadId: page.threadId,
      historyEpoch: page.historyEpoch,
      contentRevision: page.contentRevision,
      physicalRolloutId: turn.physicalRolloutId,
      turnId: turn.turnId,
      itemId: "answer",
      markdown: "**formatted**<script>bad()</script>",
    });
    expect(JSON.stringify(prepared.body)).toContain("strong");
    expect(JSON.stringify(prepared.body)).not.toContain("bad()");
    expect((await snapshot()).authority).toEqual(authority);
    expect((await snapshot()).fullReads).toBe(0);
  });
  it("preserves recoverable cache contention through a real request and retries after foreign ownership ends", async () => {
    const f = await fixture();
    const moduleUrl = pathToFileURL(resolve("server/ingestion/rolloutStream.ts")).href;
    const script = `import { RolloutStore } from ${JSON.stringify(moduleUrl)}; const store = new RolloutStore({cacheDirectory:${JSON.stringify(join(f.root, "cache/decoded-rollouts"))}}); const lease = await store.open(${JSON.stringify(rolloutRefFromSource(f.path, null))}); process.on("message", async () => { await lease.close(); await store.close(); process.send({released:true}); }); process.send({ready:true});`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    try {
      expect((await once(owner, "message"))[0]).toEqual({ ready: true });
      const metadata = await client.getSessionMetadata("thread-1");
      const unavailable = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
      expect(unavailable.preparation).toBe("unavailable");
      expect(unavailable.coverage.gaps[0]?.reason).toContain("rollout.cache_owned_elsewhere");
      expect(metadata.title).toBe("Chosen name");
      const released = once(owner, "message");
      owner.send("release");
      expect((await released)[0]).toEqual({ released: true });
      const ready = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
      expect(ready.turns[0]?.items.at(-1)?.item).toMatchObject({ text: "answer A" });
      expect(await client.getSessionMetadata("thread-1")).toEqual(metadata);
    } finally {
      owner.kill();
      await once(owner, "exit");
    }
  });
  it.each([false, true])(
    "consumes bounded opening preparation and distinguishes an unseen second prompt (%s)",
    async (secondPrompt) => {
      const f = await fixture();
      const records = [
        { type: "session_meta", payload: { id: "thread-1" } },
        { type: "event_msg", payload: { type: "user_message", message: "FIRST PROMPT" } },
        ...Array.from({ length: 4000 }, (_, index) => ({
          type: "event_msg",
          payload: { type: "agent_message", message: `first-${index}-${"x".repeat(80)}` },
        })),
        ...(secondPrompt
          ? [{ type: "event_msg", payload: { type: "user_message", message: "SECOND PROMPT" } }]
          : []),
        ...Array.from({ length: 5000 }, (_, index) => ({
          type: "event_msg",
          payload: { type: "agent_message", message: `tail-${index}-${"y".repeat(80)}` },
        })),
      ];
      await writeFile(f.path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      const first = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
      const prefix = first.turns[0];
      if (!prefix) {
        throw new Error("Expected the loaded prefix");
      }
      const tail = first.turns.at(-1)!;
      expect(tail.opening.availability).toBe("notLoaded");
      let opening = await client.getTurnItems("thread-1", {
        turnId: tail.turnId,
        anchor: { kind: "opening" },
      });
      for (let index = 0; opening.opening.availability !== "available" && index < 12; index += 1) {
        expect(opening.preparation?.cursor).toBeTruthy();
        // oxlint-disable-next-line no-await-in-loop -- Every HTTP request advances one bounded opening proof
        opening = await client.getTurnItems("thread-1", {
          turnId: tail.turnId,
          anchor: { kind: "after", cursor: opening.preparation!.cursor! },
        });
      }
      expect(opening.opening.item).toMatchObject({
        text: secondPrompt ? "SECOND PROMPT" : "FIRST PROMPT",
      });
      expect(opening.boundary?.identityAliases.includes(prefix.turnId)).toBe(!secondPrompt);
      const merged = mergeHistoryWindows(first.turns, [opening]);
      expect(merged).toHaveLength(secondPrompt ? 2 : 1);
      expect(merged.at(-1)?.coverage.gaps.length).toBeGreaterThan(0);
      expect(new Set(merged.flatMap((turn) => turn.items.map((item) => item.itemId))).size).toBe(
        merged.flatMap((turn) => turn.items).length,
      );
      const alias = secondPrompt ? tail.turnId : prefix.turnId;
      const aliasOpening = await client.getTurnItems("thread-1", {
        turnId: alias,
        anchor: { kind: "opening" },
      });
      expect(aliasOpening.turnId).toBe(alias);
      expect(aliasOpening.opening.item).toMatchObject({
        text: secondPrompt ? "SECOND PROMPT" : "FIRST PROMPT",
      });
      expect((await snapshot()).fullReads).toBe(0);
    },
  );
});

describe("cached HTTP content authorization", () => {
  it("serves only an integrity-checked unlinked file below the authorized root", async () => {
    const parent = await mkdtemp(join(httpRoot, "codex-viewer-content-boundary-"));
    const root = join(parent, "cache");
    await mkdir(root);
    const bytes = Buffer.from("private cached content");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(root, `${sha256}.bin`);
    await writeFile(path, bytes);

    const response = await contentResponse(root, {
      path,
      mimeType: null,
      sha256,
      byteSize: bytes.byteLength,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ["missing record", null],
    ["outside path", "outside"],
    ["authorized root itself", "root"],
    ["wrong filename", "filename"],
    ["wrong hash", "hash"],
    ["wrong byte size", "size"],
    ["directory", "directory"],
    ["hard link", "hardlink"],
  ])("returns 404 for %s", async (_label, variant) => {
    const parent = await mkdtemp(join(httpRoot, "codex-viewer-content-denied-"));
    const root = join(parent, "cache");
    await mkdir(root);
    const bytes = Buffer.from("cached bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const validPath = join(root, `${sha256}.bin`);
    await writeFile(validPath, bytes);
    let content: CachedContentFile | null = {
      path: validPath,
      mimeType: "text/plain",
      sha256,
      byteSize: bytes.byteLength,
    };
    if (variant === null) {
      content = null;
    } else if (variant === "outside") {
      const outside = join(parent, `${sha256}.bin`);
      await writeFile(outside, bytes);
      content.path = outside;
    } else if (variant === "root") {
      content.path = root;
    } else if (variant === "filename") {
      const wrongName = join(root, "wrong.bin");
      await writeFile(wrongName, bytes);
      content.path = wrongName;
    } else if (variant === "hash") {
      // Keep the manifest, filename, and size valid so only the byte digest can reject this.
      await writeFile(validPath, Buffer.alloc(bytes.byteLength, 120));
    } else if (variant === "size") {
      content.byteSize = bytes.byteLength + 1;
    } else if (variant === "directory") {
      const directory = join(root, `${sha256}.dir`);
      await mkdir(directory);
      content.path = directory;
    } else if (variant === "hardlink") {
      const linked = join(root, `${sha256}.linked`);
      await link(validPath, linked);
      content.path = linked;
    }

    const response = await contentResponse(root, content);

    expect(response.status).toBe(404);
  });
});

describe("live API query validation", () => {
  it("coerces numeric list parameters from the HTTP query string", async () => {
    await expect(validatedQuery("scope=active&limit=1&hasMedia=true", "list")).resolves.toEqual({
      body: { scope: "active", limit: 1, hasMedia: true },
      status: 200,
    });
  });

  it("coerces numeric turn-chunk parameters from the HTTP query string", async () => {
    await expect(validatedQuery("cursor=0&limit=200", "turn")).resolves.toEqual({
      body: { cursor: "0", limit: 200 },
      status: 200,
    });
  });

  it("coerces numeric search parameters from the HTTP query string", async () => {
    await expect(
      validatedQuery("scope=active&query=task&limit=5&hasMedia=false", "search"),
    ).resolves.toEqual({
      body: { scope: "active", query: "task", limit: 5, hasMedia: false },
      status: 200,
    });
  });

  it("rejects out-of-range and partially numeric limits instead of coercing them into valid pages", async () => {
    const responses = await Promise.all([
      validatedQuery("scope=active&limit=0", "list"),
      validatedQuery("scope=active&limit=201", "list"),
      validatedQuery("cursor=0&limit=2.5", "turn"),
      validatedQuery("scope=active&query=task&limit=10oops", "search"),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400, 400]);
  });
});

it("preserves the logical review cutoff through selected history and the actual approval endpoint", async () => {
  const f = await fixture({ records: cutoffReviewRecords("thread-1") });
  const bytes = await readFile(f.path);
  const page = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
  expect(
    page.reviewEvidence?.records.map((record) => [
      record.identity.ordinal,
      record.logicalVisibility,
    ]),
  ).toEqual([
    [5, "context-only"],
    [6, "context-only"],
    [7, "context-only"],
    [8, "context-only"],
    [9, "context-only"],
    [15, "visible"],
    [16, "visible"],
  ]);
  const evidence = await client.getApprovalEvidence("thread-1");
  expect(
    evidence.matched.map((match) => [
      match.activityId,
      match.attempts.map((review) => review.reviewId),
    ]),
  ).toEqual([["visible-command", ["visible-review"]]]);
  expect(evidence.unattached).toEqual([]);
  expect(evidence.parentSource).toMatchObject({
    availability: "complete",
    historyEpoch: page.historyEpoch,
    coverage: { status: "complete" },
  });
  expect(Buffer.compare(await readFile(f.path), bytes)).toBe(0);
  expect(await snapshot()).toMatchObject({ fullReads: 0, sessions: 0 });
});

it("keeps bounded parent review cutoff evidence unresolved when tail ordinals are unavailable", async () => {
  const records = cutoffReviewRecords("thread-1");
  records.splice(
    12,
    0,
    ...Array.from({ length: 6000 }, () => ({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(1024) },
    })),
  );
  const f = await fixture({ records });
  const bytes = await readFile(f.path);
  const before = await snapshot();
  const page = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
  expect(page.reviewEvidence).toMatchObject({ availability: "unresolved" });
  expect(
    page.reviewEvidence?.records.map((record) => [
      record.identity.ordinal,
      record.logicalVisibility,
    ]),
  ).toEqual([
    [5, "context-only"],
    [6, "context-only"],
    [7, "context-only"],
    [8, "context-only"],
    [9, "context-only"],
    [null, "unresolved"],
    [null, "unresolved"],
  ]);
  const evidence = await client.getApprovalEvidence("thread-1");
  expect(evidence).toMatchObject({
    matched: [],
    unattached: [],
    parentSource: {
      availability: "unresolved",
      historyEpoch: page.historyEpoch,
      coverage: {
        status: "partial",
        gaps: expect.arrayContaining([
          expect.objectContaining({ reason: "ordinal-cutoff-unproved" }),
        ]),
      },
    },
  });
  const after = await snapshot();
  expect(after.requestedBytes - before.requestedBytes).toBeLessThan(4 * 1024 * 1024);
  expect(after).toMatchObject({ fullReads: 0, sessions: 0 });
  expect(Buffer.compare(await readFile(f.path), bytes)).toBe(0);
});

it("ingests bounded parent review notifications through selected history and the actual approval endpoint", async () => {
  const parent = parentReviewRecords("thread-1");
  const prefix = [
    parent[0],
    { type: "event_msg", payload: { type: "task_started", turn_id: "old" } },
    ...Array.from({ length: 6000 }, () => ({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(1024) },
    })),
    { type: "event_msg", payload: { type: "task_complete", turn_id: "old" } },
  ];
  const records = [...prefix, ...parent.slice(1)];
  const f = await fixture({ records });
  const bytes = await readFile(f.path);
  const firstReviewOffset = Buffer.byteLength(
    records
      .slice(0, prefix.length + 4)
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  await client.getSessionMetadata("thread-1");
  expect(await snapshot()).toMatchObject({ fullReads: 0, sessions: 0, rolloutOpens: 0 });
  const page = await client.getHistoryPage("thread-1", { anchor: { kind: "latest" } });
  expect(page.reviewEvidence).toMatchObject({ availability: "partial" });
  expect(page.reviewEvidence?.records).toHaveLength(5);
  expect(page.turns.flatMap((turn) => turn.items.map((item) => item.itemId))).toEqual(
    expect.arrayContaining(["command", "mcp"]),
  );
  expect(page.turns.flatMap((turn) => turn.items.map((item) => item.itemId))).not.toContain(
    "review-a",
  );
  const before = await snapshot();
  const evidence = await client.getApprovalEvidence("thread-1");
  expect(evidence.parentSource).toMatchObject({
    availability: "partial",
    historyEpoch: page.historyEpoch,
    coverage: { status: "partial" },
  });
  expect(evidence.parentSource?.contentRevision).toMatch(/^[a-f0-9]{64}$/u);
  expect(evidence.matched).toMatchObject([
    {
      activityId: "command",
      attempts: [
        { reviewId: "review-a", outcome: "allow" },
        { reviewId: "review-b", outcome: null },
      ],
    },
  ]);
  expect(evidence.unattached.map(({ review, reason }) => [review.reviewId, reason])).toEqual([
    ["network", "missing-target"],
    ["mcp-denied", "standalone-denial"],
  ]);
  const sources = evidence.matched[0]?.attempts[0]?.sourceRecords;
  expect(sources).toHaveLength(2);
  expect(sources?.[0]?.identity).toMatchObject({
    physicalRolloutId: "thread-1",
    ordinal: null,
    decodedByteStart: firstReviewOffset,
  });
  expect(sources?.[1]?.identity.decodedByteStart).toBeGreaterThan(firstReviewOffset);
  expect(sources?.[0]?.envelope).toMatchObject({
    method: "item/autoApprovalReview/started",
    params: { threadId: "thread-1", turnId: "turn", reviewId: "review-a", targetItemId: "command" },
  });
  const after = await snapshot();
  expect(after).toMatchObject({ fullReads: 0, sessions: 0 });
  expect(after.requestedBytes - before.requestedBytes).toBeLessThan(2 * 1024 * 1024);
  expect(Buffer.compare(await readFile(f.path), bytes)).toBe(0);
  await fixture({
    records: records.filter((record) => record !== undefined && !Object.hasOwn(record, "method")),
  });
  const empty = await client.getApprovalEvidence("thread-1");
  expect(empty).toMatchObject({
    matched: [],
    unattached: [],
    parentSource: { availability: "partial", coverage: { status: "partial" } },
  });
});
