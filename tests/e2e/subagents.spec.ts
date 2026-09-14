import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@nuxt/test-utils/playwright";

import type {
  ConversationMessage,
  ConversationSummary,
  ConversationTurn,
  TurnNavigatorItem,
} from "../../shared/types/conversation.ts";
import type { ConversationListItem } from "../../shared/types/library.ts";
import type { TurnChunk } from "../../shared/types/repository.ts";

const parentId = "88888888-8888-4888-8888-888888888888";
const childId = "99999999-9999-4999-8999-999999999999";
const nestedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timestamp = "2026-09-14T12:00:00.000Z";
const titles: Record<string, string> = {
  [parentId]: "Parent fixture",
  [childId]: "Child fixture",
  [nestedId]: "Nested fixture",
};

function summary(id: string): ConversationSummary {
  return {
    id,
    title: titles[id] ?? id,
    scope: "active",
    sourcePath: "fixture.jsonl",
    createdAt: timestamp,
    updatedAt: timestamp,
    cwd: null,
    gitBranch: null,
    gitSha: null,
    gitOriginUrl: null,
    models: [],
    reasoningEfforts: [],
    turnCount: 40,
    assistantMessageCount: 40,
    toolCallCount: 0,
    toolCounts: {},
    preview: "Subagent fixture",
    pinned: false,
    sectionName: null,
    parentThreadId: id === parentId ? null : parentId,
    childThreadIds: id === parentId ? [childId] : id === childId ? [nestedId] : [],
    hasMedia: false,
    diagnosticCount: 0,
    revision: "fixture-1",
  };
}
function message(id: string, index: number, role: "user" | "assistant"): ConversationMessage {
  const text = `${titles[id]} ${role} ${index}`;
  return {
    id: `${id}-${role}-${index}`,
    turnId: `${id}-${index}`,
    role,
    phase: role === "assistant" ? "final" : null,
    createdAt: timestamp,
    sourceMarkdown: text,
    body: {
      type: "document",
      children: [
        { type: "element", tagName: "p", attributes: {}, children: [{ type: "text", text }] },
      ],
    },
    attachmentIds: [],
    rawEventIds: [],
  };
}
function turn(id: string, index: number): ConversationTurn {
  return {
    id: `${id}-${index}`,
    sessionId: id,
    sourceTurnId: null,
    index,
    userMessage: message(id, index, "user"),
    assistantMessages: [message(id, index, "assistant")],
    activities:
      id === childId && index === 39
        ? [
            {
              id: "nested-activity",
              turnId: `${id}-${index}`,
              kind: "subagent",
              status: "succeeded",
              agentId: nestedId,
              parentThreadId: childId,
              childThreadId: nestedId,
              description: "Nested worker",
              createdAt: timestamp,
              rawEventIds: [],
            },
          ]
        : [],
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 1000,
    timeToFirstTokenMs: 20,
    tokenDelta: null,
    models: [],
    reasoningEfforts: [],
    toolCounts: {},
    diagnosticIds: [],
  };
}
function navigator(id: string): TurnNavigatorItem[] {
  return Array.from({ length: 40 }, (_, index) => ({
    turnId: `${id}-${index}`,
    index,
    userMessageId: `${id}-user-${index}`,
    promptPreview: `${titles[id]} user ${index}`,
    assistantPreview: `${titles[id]} assistant ${index}`,
    proseLengthBucket: 1,
    createdAt: timestamp,
  }));
}
function childItem(id: string): ConversationListItem {
  return {
    summary: summary(id),
    kind: "subagent",
    materialization: "ready",
    projectId: "fixture",
    parentThreadId: parentId,
    agentPath: "worker",
    agentNickname: "Ada",
    agentDepth: 1,
    childCount: 1,
  };
}

test("opens nested subagents locally with independent embedded controls and preserves the parent reading position", async ({
  page,
  goto,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    class SilentEventSource extends EventTarget {
      close() {}
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: SilentEventSource });
    window.localStorage.setItem(
      "codex-sessions-viewer:presentation:v1",
      JSON.stringify({ version: 1, settings: { liveFollow: false } }),
    );
  });
  const childCursors: string[] = [];
  await page.route("**/api/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/sessions" && url.searchParams.get("parentThreadId") === parentId) {
      return route.fulfill({ json: { items: [childItem(childId)], nextCursor: null, total: 1 } });
    }
    const id = url.pathname.split("/")[3];
    if (id === undefined || titles[id] === undefined) {
      return route.fallback();
    }
    if (url.pathname.endsWith("/navigator")) {
      return route.fulfill({ json: navigator(id) });
    }
    if (url.pathname.endsWith("/turns")) {
      const cursor = url.searchParams.get("cursor") ?? "0";
      if (id === childId) {
        childCursors.push(cursor);
      }
      const start = url.searchParams.has("targetTurnId") ? 20 : Number(cursor) * 20;
      const chunk: TurnChunk = {
        sessionId: id,
        turns: Array.from({ length: 20 }, (_, index) => turn(id, start + index)),
        previousCursor: start > 0 ? "0" : null,
        nextCursor: start === 0 ? "1" : null,
        revision: "fixture-1",
      };
      return route.fulfill({ json: chunk });
    }
    return route.fulfill({ json: summary(id) });
  });
  await goto(`/session/${parentId}?turn=${parentId}-30`, { waitUntil: "hydration" });
  const parentTimeline = page.locator(".session-page__main .conversation-timeline");
  await expect(parentTimeline.locator(`[data-turn-id="${parentId}-30"]`)).toBeVisible();
  await parentTimeline.evaluate((element) => {
    element.setAttribute("data-parent-sentinel", "preserved");
  });
  const parentUrl = page.url();
  await page.getByRole("button", { name: "Subagents · 1", exact: true }).click();
  const panel = page.locator(".subagent-panel");
  await expect(panel.getByRole("heading", { name: "Subagents", exact: true })).toBeVisible();
  // Opening the grid can reflow the parent; child selection must preserve the resulting reading position.
  await expect(parentTimeline.locator(`[data-turn-id="${parentId}-30"]`)).toBeVisible();
  const parentScroll = await parentTimeline.evaluate((element) => element.scrollTop);
  await panel.getByRole("button", { name: /Ada Child fixture/u }).click();
  await expect(panel.getByText("Child fixture assistant 39", { exact: true })).toBeVisible();
  expect(childCursors[0]).toBe("1");
  await expect(page).toHaveURL(parentUrl);
  await expect(parentTimeline).toHaveAttribute("data-parent-sentinel", "preserved");
  await expect
    .poll(async () =>
      Math.abs((await parentTimeline.evaluate((element) => element.scrollTop)) - parentScroll),
    )
    .toBeLessThanOrEqual(3);
  const embeddedTimeline = panel.locator(".conversation-timeline");
  const panelBox = await panel.boundingBox();
  const childBox = await embeddedTimeline.boundingBox();
  expect(childBox!.height).toBeGreaterThan(200);
  expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 2);
  expect(
    await page.locator("[id]").evaluateAll((elements) => {
      const ids = elements.map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    }),
  ).toEqual([]);
  const accessibility = await new AxeBuilder({ page })
    .include(".subagent-panel")
    .withRules(["duplicate-id-aria", "aria-valid-attr-value", "aria-required-attr"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await panel.locator(".conversation-work-stream > summary").click();
  await panel.locator('[data-entry-id="nested-activity"] details > summary').click();
  await panel.getByRole("link", { name: "Open Nested worker conversation" }).click();
  await expect(panel.getByText("Nested fixture assistant 39", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(parentUrl);
  await expect(parentTimeline).toHaveAttribute("data-parent-sentinel", "preserved");
  await expect
    .poll(async () =>
      Math.abs((await parentTimeline.evaluate((element) => element.scrollTop)) - parentScroll),
    )
    .toBeLessThanOrEqual(3);
  await panel.getByRole("button", { name: "Back to subagents" }).click();
  await expect(panel.getByRole("heading", { name: "Subagents", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /Ada Child fixture/u }).click();
  await expect(panel.getByText("Child fixture assistant 39", { exact: true })).toBeVisible();
  await panel.getByRole("link", { name: "Open subagent as a full session" }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${childId}$`, "u"));
  await expect(page.locator(".session-page__main h1")).toHaveText("Child fixture");
});
