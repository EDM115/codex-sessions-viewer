import { expect, test } from "@nuxt/test-utils/playwright";
import type { Locator } from "@playwright/test";

import type {
  ConversationMessage,
  ConversationSummary,
  ConversationTurn,
  TurnNavigatorItem,
} from "../../shared/types/conversation.ts";
import type { TurnChunk } from "../../shared/types/repository.ts";
import type { RichTextNode } from "../../shared/types/richText.ts";

const sessionId = "77777777-7777-4777-8777-777777777777";
const timestamp = "2026-09-14T12:00:00.000Z";
function message(index: number, role: "user" | "assistant"): ConversationMessage {
  const text =
    role === "user"
      ? `Geometry prompt ${index}`
      : `Response ${index}. A deterministic paragraph with enough words to wrap differently when the viewport narrows. `;
  const paragraphs = role === "user" ? 1 : index % 4 === 1 ? 18 : 2;
  const children: RichTextNode[] = Array.from({ length: paragraphs }, (_, paragraph) => ({
    type: "element",
    tagName: "p",
    attributes: {},
    children: [{ type: "text", text: `${text}${paragraph}` }],
  }));
  if (role === "assistant" && index % 4 === 2) {
    children.push({
      type: "code",
      source: Array.from({ length: 25 }, (_, line) => `const line${line} = ${line};`).join("\n"),
      language: "text",
      title: null,
      highlighted: null,
    });
  }
  return {
    id: `${role}-${index}`,
    turnId: `geometry-${index}`,
    role,
    phase: role === "assistant" ? "final" : null,
    createdAt: timestamp,
    sourceMarkdown: text,
    body: { type: "document", children },
    attachmentIds: [],
    rawEventIds: [],
  };
}
function turn(index: number): ConversationTurn {
  return {
    id: `geometry-${index}`,
    sourceTurnId: null,
    sessionId,
    index,
    userMessage: message(index, "user"),
    assistantMessages: [message(index, "assistant")],
    activities:
      index % 4 === 3
        ? Array.from({ length: 12 }, (_, activity) => ({
            id: `activity-${index}-${activity}`,
            turnId: `geometry-${index}`,
            kind: "tool",
            namespace: null,
            name: "exec_command",
            callId: null,
            status: "succeeded",
            createdAt: timestamp,
            startedAt: timestamp,
            completedAt: timestamp,
            durationMs: 10,
            rawEventIds: [],
            input: { cmd: `echo ${activity}` },
            output: "output\n".repeat(100),
            error: null,
          }))
        : [],
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 1_000,
    timeToFirstTokenMs: 50,
    tokenDelta: null,
    models: [],
    reasoningEfforts: [],
    toolCounts: {},
    diagnosticIds: [],
  };
}
const turns = Array.from({ length: 120 }, (_, index) => turn(index));
const navigator: TurnNavigatorItem[] = turns.map((item) => ({
  turnId: item.id,
  index: item.index,
  userMessageId: item.userMessage!.id,
  promptPreview: `Geometry prompt ${item.index}`,
  assistantPreview: `Response ${item.index}`,
  proseLengthBucket: item.index % 4 === 1 ? 4 : 2,
  createdAt: timestamp,
}));
const summary: ConversationSummary = {
  id: sessionId,
  title: "Timeline geometry fixture",
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
  turnCount: 120,
  assistantMessageCount: 120,
  toolCallCount: 360,
  toolCounts: {},
  preview: "Geometry fixture",
  pinned: false,
  sectionName: null,
  parentThreadId: null,
  childThreadIds: [],
  hasMedia: false,
  diagnosticCount: 0,
  revision: "fixture-1",
};
function chunk(start: number, end: number): TurnChunk {
  return {
    sessionId,
    turns: turns.slice(start, end),
    previousCursor: start > 0 ? String(start) : null,
    nextCursor: end < 120 ? String(end) : null,
    revision: "fixture-1",
  };
}
async function relativeTop(anchor: Locator): Promise<number> {
  return anchor.evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      element.closest(".conversation-timeline")!.getBoundingClientRect().top,
  );
}

for (const liveFollow of [true, false]) {
  test(`preserves a deep variable-height reading anchor through append, deferred prepend and delayed layout changes (live follow ${liveFollow})`, async ({
    page,
    goto,
  }) => {
    await page.addInitScript((follow) => {
      window.localStorage.setItem(
        "codex-sessions-viewer:presentation:v1",
        JSON.stringify({ version: 1, settings: { liveFollow: follow } }),
      );
    }, liveFollow);
    let releaseBefore!: () => void;
    let beforeRequested = false;
    let afterRequested = false;
    let refreshRequested = false;
    let refreshing = false;
    await page.addInitScript(() => {
      class FixtureEventSource extends EventTarget {
        forward = () =>
          this.dispatchEvent(
            new MessageEvent("session.updated", {
              data: JSON.stringify({
                type: "session.updated",
                ids: ["77777777-7777-4777-8777-777777777777"],
                revision: "fixture-2",
              }),
            }),
          );
        constructor() {
          super();
          window.addEventListener("geometry-invalidate", this.forward);
        }
        close() {
          window.removeEventListener("geometry-invalidate", this.forward);
        }
      }
      Object.defineProperty(window, "EventSource", {
        configurable: true,
        value: FixtureEventSource,
      });
    });
    const beforeGate = new Promise<void>((resolve) => {
      releaseBefore = resolve;
    });
    await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/navigator")) {
        return route.fulfill({ json: navigator });
      }
      if (url.pathname.endsWith("/turns")) {
        if (url.searchParams.get("direction") === "before") {
          beforeRequested = true;
          await beforeGate;
          return route.fulfill({ json: chunk(0, 20) });
        }
        if (url.searchParams.get("direction") === "after") {
          afterRequested = true;
          return route.fulfill({ json: chunk(100, 120) });
        }
        if (refreshing) {
          refreshRequested = true;
          const refreshed = chunk(40, 80);
          refreshed.revision = "fixture-2";
          refreshed.turns = refreshed.turns.map((item) =>
            item.index !== 60
              ? item
              : {
                  ...item,
                  assistantMessages: [
                    { ...message(60, "assistant"), body: message(61, "assistant").body },
                  ],
                },
          );
          return route.fulfill({ json: refreshed });
        }
        return route.fulfill({ json: chunk(20, 100) });
      }
      return route.fulfill({ json: summary });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await goto(`/session/${sessionId}?turn=geometry-61`, { waitUntil: "hydration" });
    const scroller = page.locator(".conversation-timeline");
    const anchor = scroller.locator('[data-turn-id="geometry-61"]');
    await expect(anchor).toBeVisible();
    // Visit separate measured ranges before returning to the deep reading turn.
    await page.locator('.turn-minimap__target[aria-current="true"]').press("ArrowUp");
    const previousMarker = page.locator('.turn-minimap__target[data-turn-id="geometry-60"]');
    await expect(previousMarker).toHaveAttribute("aria-current", "true");
    await previousMarker.press("ArrowDown");
    await expect(page.locator('.turn-minimap__target[data-turn-id="geometry-61"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(anchor).toBeInViewport();
    await expect.poll(async () => Math.abs(await relativeTop(anchor))).toBeLessThanOrEqual(3);
    await scroller.evaluate((element) => {
      element.scrollTop += 80;
    });
    await expect
      .poll(async () => Math.abs((await relativeTop(anchor)) + 80))
      .toBeLessThanOrEqual(3);
    await expect(anchor).toBeInViewport();
    const beforeAppend = await relativeTop(anchor);
    await page
      .getByRole("button", { name: "Load later turns" })
      .evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await expect.poll(() => afterRequested).toBe(true);
    await expect(page.getByRole("button", { name: "Load later turns" })).toBeHidden();
    await expect
      .poll(async () => Math.abs((await relativeTop(anchor)) - beforeAppend))
      .toBeLessThanOrEqual(3);
    await page
      .getByRole("button", { name: "Load earlier turns" })
      .evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await expect.poll(() => beforeRequested).toBe(true);
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 96 }));
      element.scrollTop += 96;
    });
    await expect(anchor).toBeInViewport();
    const beforePrepend = await relativeTop(anchor);
    releaseBefore();
    await expect(page.getByRole("button", { name: "Load earlier turns" })).toBeHidden();
    await expect(anchor).toBeVisible();
    await expect
      .poll(async () => Math.abs((await relativeTop(anchor)) - beforePrepend))
      .toBeLessThanOrEqual(3);
    const worked = scroller.locator('[data-turn-id="geometry-59"] .conversation-work-stream');
    await worked.locator(":scope > summary").evaluate((element) => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      if (element instanceof HTMLElement) {
        element.click();
      }
    });
    await expect(worked).toHaveAttribute("open", "");
    await expect
      .poll(async () => Math.abs((await relativeTop(anchor)) - beforePrepend))
      .toBeLessThanOrEqual(3);
    await worked.locator(":scope > summary").evaluate((element) => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      if (element instanceof HTMLElement) {
        element.click();
      }
    });
    await expect(worked).not.toHaveAttribute("open");
    await expect
      .poll(async () => Math.abs((await relativeTop(anchor)) - beforePrepend))
      .toBeLessThanOrEqual(3);
    refreshing = true;
    await page.evaluate(() => window.dispatchEvent(new Event("geometry-invalidate")));
    await expect.poll(() => refreshRequested).toBe(true);
    await expect
      .poll(async () => Math.abs((await relativeTop(anchor)) - beforePrepend))
      .toBeLessThanOrEqual(3);
    // A late image changes an already mounted row above the reading line, well after settlement.
    await scroller.evaluate(async (element) => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        );
      });
      const previous = element.querySelector<HTMLElement>('[data-turn-id="geometry-60"]')!;
      const image = document.createElement("img");
      image.alt = "Delayed fixture image";
      image.style.cssText = "display:block;width:300px;height:350px";
      image.src =
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="350"><rect width="300" height="350" fill="navy"/></svg>',
        );
      previous.append(image);
    });
    await expect
      .poll(async () => Math.abs((await relativeTop(anchor)) - beforePrepend))
      .toBeLessThanOrEqual(3);
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(anchor).toBeInViewport();
    await expect
      .poll(async () => Math.abs((await relativeTop(anchor)) - beforePrepend))
      .toBeLessThanOrEqual(3);
    expect(await scroller.locator(".conversation-turn").count()).toBeLessThan(20);
    expect(await page.locator(".turn-minimap__target").count()).toBeLessThan(80);
  });
}

test("keeps the reading window when a wheel cancels a deferred deep target", async ({
  page,
  goto,
}) => {
  let releaseTarget!: () => void;
  let targetRequested = false;
  const targetGate = new Promise<void>((resolve) => {
    releaseTarget = resolve;
  });
  await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/navigator")) {
      return route.fulfill({ json: navigator });
    }
    if (url.pathname.endsWith("/turns")) {
      if (url.searchParams.get("targetTurnId") === "geometry-0") {
        targetRequested = true;
        await targetGate;
        return route.fulfill({ json: chunk(0, 5) });
      }
      return route.fulfill({ json: chunk(20, 100) });
    }
    return route.fulfill({ json: summary });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await goto(`/session/${sessionId}?turn=geometry-61`, { waitUntil: "hydration" });
  const scroller = page.locator(".conversation-timeline");
  const anchor = scroller.locator('[data-turn-id="geometry-61"]');
  await expect(anchor).toBeVisible();
  await page.locator('.turn-minimap__target[aria-current="true"]').press("Home");
  await expect.poll(() => targetRequested).toBe(true);
  await expect(page.locator('.turn-minimap__target[data-turn-id="geometry-0"]')).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 96 }));
    element.scrollTop += 96;
  });
  const readingOffset = await relativeTop(anchor);
  await expect(
    page.locator('.turn-minimap__target[data-turn-id="geometry-0"]'),
  ).not.toHaveAttribute("aria-busy");
  const response = page.waitForResponse(
    (received) => new URL(received.url()).searchParams.get("targetTurnId") === "geometry-0",
  );
  releaseTarget();
  await response;
  // Allow the fulfilled request and Vue render to settle before checking the retained window.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(anchor).toBeVisible();
  await expect
    .poll(async () => Math.abs((await relativeTop(anchor)) - readingOffset))
    .toBeLessThanOrEqual(3);
  await expect(page).toHaveURL(/turn=geometry-61/u);
  await expect(page.getByRole("button", { name: "Load earlier turns" })).toBeEnabled();
});
