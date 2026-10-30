import { fileURLToPath } from "node:url";

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@nuxt/test-utils/playwright";

import type { HistoryItem, HistoryPage, HistoryTurnWindow } from "#shared/types/history.ts";
import { historyNavigatorPage } from "#shared/types/history.ts";
import type { CatalogSessionMetadata, LibraryEntry } from "#shared/types/library.ts";

const parentId = "88888888-8888-4888-8888-888888888888";
const childId = "99999999-9999-4999-8999-999999999999";
const siblingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const nestedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timestamp = "2026-09-14T12:00:00.000Z";
const names: Record<string, string> = {
  [parentId]: "Parent fixture",
  [childId]: "Child fixture",
  [siblingId]: "Unselected sibling",
  [nestedId]: "Nested fixture",
};
test.use({
  nuxt: {
    rootDir: fileURLToPath(new URL("../..", import.meta.url)),
    dev: false,
    build: true,
    nuxtConfig: {
      experimental: { buildCache: false },
    },
    env: {
      LOCALAPPDATA: fileURLToPath(
        new URL("../../.tmp/task10-browser/progressive/", import.meta.url),
      ),
      CODEX_VIEWER_MODE: "live",
      CODEX_VIEWER_CODEX_HOME: fileURLToPath(new URL("../fixtures", import.meta.url)),
    },
  },
});

function metadata(id: string): CatalogSessionMetadata {
  return {
    id,
    title: names[id] ?? id,
    scope: "active",
    sourcePath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    cwd: null,
    gitBranch: null,
    gitSha: null,
    gitOriginUrl: null,
    pinned: false,
    sectionName: null,
    parentThreadId: id === parentId ? null : parentId,
    childThreadIds: id === parentId ? [childId, siblingId] : id === childId ? [nestedId] : [],
    revision: "metadata-1",
  };
}
function childEntry(id: string): LibraryEntry {
  return {
    id,
    title: names[id] ?? id,
    scope: "active",
    projectId: null,
    orderKey: timestamp,
    kind: "subagent",
    parentThreadId: parentId,
    childCount: id === childId ? 1 : 0,
    agent: {
      name: id === childId ? "Ada" : "Grace",
      role: "reviewer",
      path: id === childId ? "review" : "other",
    },
  };
}
function history(id: string): HistoryPage {
  const turnId = `${id}-turn`;
  const base = { startedAtMs: null, completedAtMs: null, evidence: null };
  const user: HistoryItem = {
    ...base,
    id: `${id}-prompt`,
    type: "userMessage",
    text: `${names[id]} prompt`,
    content: [],
    clientId: null,
  };
  const final: HistoryItem = {
    ...base,
    id: `${id}-final`,
    type: "agentMessage",
    text: `${names[id]} final answer`,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  const command = (itemId: string, exitCode: number | null): HistoryItem => ({
    ...base,
    id: itemId,
    type: "commandExecution",
    command: `node ${itemId}`,
    commandArgs: null,
    cwd: "/fixture",
    commandActions: [],
    processId: null,
    source: null,
    status: "completed",
    output: `${itemId} output`,
    exitCode,
    durationMs: 4,
  });
  const work: HistoryItem[] =
    id === parentId
      ? [
          {
            ...base,
            id: "reason-empty",
            type: "reasoning",
            summary: [],
            content: [],
            evidence: { encrypted_content: "opaque-only" },
          },
          {
            ...base,
            id: "reason-summary",
            type: "reasoning",
            summary: ["Readable summary"],
            content: ["Readable summary"],
          },
          {
            ...base,
            id: "reason-duplicate",
            type: "reasoning",
            summary: ["Readable summary"],
            content: [],
          },
          {
            ...base,
            id: "reason-body",
            type: "reasoning",
            summary: [],
            content: ["Plain body fallback"],
          },
          {
            ...base,
            id: "progress",
            type: "agentMessage",
            text: "Chronological progress",
            phase: "commentary",
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
          command("command-one", 0),
          command("command-two", 0),
          command("command-failed", 7),
          command("command-unknown", null),
          {
            ...base,
            id: "spawn",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: parentId,
            receiverThreadIds: [childId],
            prompt: "Review the implementation",
            model: null,
            reasoningEffort: null,
            agentsStates: { [childId]: { status: "completed", message: null } },
          },
        ]
      : id === childId
        ? [
            {
              ...base,
              id: "nested-activity",
              type: "subAgentActivity",
              kind: "spawned",
              agentThreadId: nestedId,
              agentPath: "Nested worker",
              model: null,
              reasoningEffort: null,
            },
          ]
        : [];
  const items = [user, ...work, final].map((item, index) => ({
    physicalRolloutId: `physical-${id}`,
    itemId: item.id,
    item,
    ordinal: index,
    updatedAtOrdinal: index,
    detail: "full" as const,
  }));
  const turn: HistoryTurnWindow = {
    turnId,
    physicalRolloutId: `physical-${id}`,
    order: 0,
    status: "completed",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    opening: { itemId: user.id, item: user, availability: "available" },
    items,
    itemsView: "full",
    beforeCursor: null,
    afterCursor: null,
    loadedRanges: [
      { physicalRolloutId: `physical-${id}`, startOrdinal: 0, endOrdinalExclusive: items.length },
    ],
    itemIslands: [items.map((item) => item.itemId)],
    coverage: { status: "partial", segments: [], gaps: [] },
    finalAnswerItemId: final.id,
    historyEpoch: `epoch-${id}`,
    contentRevision: "content-1",
  };
  return {
    threadId: id,
    metadataRevision: "metadata-1",
    contentRevision: "content-1",
    historyEpoch: turn.historyEpoch,
    turns: [turn],
    beforeCursor: null,
    afterCursor: null,
    coverage: turn.coverage,
    preparation: "partial",
  };
}

test("reads progressive work and selects one child lazily with native keyboard and modified navigation", async ({
  page,
  goto,
  context,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    class SilentEventSource extends EventTarget {
      close() {}
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: SilentEventSource });
    localStorage.setItem(
      "codex-sessions-viewer:presentation:v1",
      JSON.stringify({
        version: 1,
        settings: {
          liveFollow: false,
          reasoningDefault: "expanded",
          toolCallsDefault: "collapsed",
        },
      }),
    );
  });
  const paths: string[] = [];
  const prepared: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/history/presentation", async (route) => {
    const query = route.request().postDataJSON();
    prepared.push(query.itemId);
    return route.fulfill({
      json: {
        ...query,
        body: { type: "document", children: [{ type: "text", text: query.markdown }] },
      },
    });
  });
  await page.route("**/api/sessions**", async (route) => {
    const url = new URL(route.request().url());
    paths.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/sessions") {
      return route.fulfill({
        json: {
          items:
            url.searchParams.get("parentThreadId") === parentId
              ? [childEntry(childId), childEntry(siblingId)]
              : [],
          nextCursor: null,
          total: 2,
        },
      });
    }
    const id = url.pathname.split("/")[3];
    if (!id || !names[id]) {
      return route.fallback();
    }
    if (url.searchParams.has("legacy")) {
      throw new Error("Progressive controls requested a legacy whole-session path");
    }
    if (url.pathname.endsWith("/turns")) {
      return route.fulfill({ json: history(id) });
    }
    if (url.pathname.endsWith("/navigator")) {
      return route.fulfill({ json: historyNavigatorPage(history(id)) });
    }
    if (url.pathname.endsWith("/approvals")) {
      return route.fulfill({
        json: {
          sessionId: id,
          matched: [
            {
              activityId: "command-one",
              attempts: [
                {
                  reviewedAction: null,
                  outcome: "deny",
                  riskLevel: "low",
                  userAuthorization: null,
                  rationale: "Denied rationale retained",
                  reviewedAt: null,
                  guardianSessionId: null,
                  parentThreadId: id,
                  rawEventIds: [],
                },
                {
                  reviewedAction: null,
                  outcome: null,
                  status: "timed_out",
                  riskLevel: "unknown",
                  userAuthorization: null,
                  rationale: "Timed out rationale",
                  reviewedAt: null,
                  guardianSessionId: null,
                  parentThreadId: id,
                  rawEventIds: [],
                },
              ],
            },
          ],
          unattached: [],
          parentSource: {
            availability: "partial",
            historyEpoch: "separate-raw-epoch",
            contentRevision: "raw-1",
            coverage: null,
          },
        },
      });
    }
    return route.fulfill({ json: metadata(id) });
  });
  await goto(`/session/${parentId}`, { waitUntil: "hydration" });
  const parent = page.locator(".session-page__main .progressive-conversation");
  const parentWorkbench = page.locator(".session-page__main .progressive-workbench");
  await expect(parent.getByText("Parent fixture final answer", { exact: true })).toBeVisible();
  await expect(parent.locator(".conversation-work-stream__entries")).toHaveCount(0);
  expect(paths.some((path) => path.endsWith("/approvals"))).toBe(false);
  expect(prepared.every((id) => id.endsWith("-prompt") || id.endsWith("-final"))).toBe(true);
  const work = parent.locator(".conversation-work-stream > summary");
  await work.focus();
  await work.press("Enter");
  await expect(work).toHaveAttribute("aria-expanded", "true");
  await expect(parent.locator(".conversation-reasoning")).toHaveCount(2);
  await expect(parent.getByText("Readable summary", { exact: true })).toHaveCount(1);
  await expect(parent.getByText("Plain body fallback", { exact: true })).toBeVisible();
  await expect(parent.locator('[data-entry-id="reason-empty"]')).toHaveCount(0);
  await expect(parent.getByText("Chronological progress", { exact: true })).toBeVisible();
  await expect(parent.locator('[data-entry-id="command-unknown"] summary')).toContainText(
    "Unknown",
  );
  expect(
    await parent
      .locator(".conversation-activity-disclosure__caret")
      .evaluate((element) => getComputedStyle(element).transitionProperty),
  ).not.toContain("transform");
  await parentWorkbench
    .getByRole("button", { name: "Load approval evidence", exact: true })
    .click();
  await expect(parentWorkbench.getByText(/Approval source: partial/u)).toBeVisible();
  await expect(
    parent.locator(".conversation-tool-row__approval > summary").filter({ hasText: "Denied" }),
  ).toBeVisible();
  await expect(parent.getByText("Denied rationale retained", { exact: true })).toHaveCount(0);
  const spawn = parent.locator('[data-entry-id="spawn"] > details > summary');
  await spawn.click();
  const link = parent.locator(`a[href="/session/${childId}"]`);
  // oxlint-disable no-await-in-loop -- Each isolated browser event must complete before the next assertion observes navigation state
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
    expect(
      await link.evaluate((element, init) => {
        const event = new MouseEvent("click", { ...init, bubbles: true, cancelable: true });
        let preventedByProduct: boolean | null = null;
        element.addEventListener(
          "click",
          (observed) => {
            preventedByProduct = observed.defaultPrevented;
            observed.preventDefault();
          },
          { once: true },
        );
        element.dispatchEvent(event);
        return preventedByProduct;
      }, options),
    ).toBe(false);
  }
  // oxlint-enable no-await-in-loop
  await expect(page.locator(".subagent-panel")).toHaveCount(0);
  await link.focus();
  await link.press("Enter");
  const panel = page.locator(".subagent-panel");
  await expect(panel.getByText("Child fixture final answer", { exact: true })).toBeVisible();
  expect(paths.filter((path) => path.startsWith(`/api/sessions/${childId}/turns?`))).toHaveLength(
    1,
  );
  expect(paths.some((path) => path.startsWith(`/api/sessions/${siblingId}`))).toBe(false);
  await expect(page).toHaveURL(new RegExp(`/session/${parentId}$`, "u"));
  await panel.getByRole("button", { name: "Close subagents" }).click();
  await expect(link).toBeFocused();
  const openList = parentWorkbench.getByRole("button", { name: "Subagents · 2", exact: true });
  await openList.click();
  await expect(panel.getByRole("button", { name: /Child fixture Ada reviewer/u })).toBeVisible();
  expect(paths.some((path) => path.startsWith(`/api/sessions/${siblingId}`))).toBe(false);
  await panel.getByRole("button", { name: /Child fixture Ada reviewer/u }).click();
  await expect(panel.getByText("Child fixture final answer", { exact: true })).toBeVisible();
  await panel.locator(".conversation-work-stream > summary").click();
  await panel.locator('[data-entry-id="nested-activity"] details > summary').click();
  await panel.getByRole("link", { name: /Open Nested worker.*conversation/u }).press("Enter");
  await expect(panel.getByText("Nested fixture final answer", { exact: true })).toBeVisible();
  expect(paths.filter((path) => path.startsWith(`/api/sessions/${nestedId}/turns?`))).toHaveLength(
    1,
  );
  const accessibility = await new AxeBuilder({ page })
    .include(".subagent-panel")
    .withRules(["duplicate-id-aria", "aria-valid-attr-value", "aria-required-attr"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});
