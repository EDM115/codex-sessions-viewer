import { fileURLToPath } from "node:url";

import { expect, test } from "@nuxt/test-utils/playwright";
import type { Locator } from "@playwright/test";

import { parseRichText } from "../../server/content/parseRichText.ts";
import {
  historyNavigatorPage,
  type HistoryPage,
  type HistoryTurnWindow,
} from "../../shared/types/history.ts";

test.use({
  nuxt: {
    rootDir: fileURLToPath(new URL("../fixtures/nuxt-viewport", import.meta.url)),
    dev: false,
    host: process.env["CODEX_VIEWER_TEST_URL"],
    build: true,
  },
});
const sessionId = "77777777-7777-4777-8777-777777777777";
function historyWindow(index: number): HistoryTurnWindow {
  const base = { startedAtMs: null, completedAtMs: null, evidence: null };
  const prompt = {
    ...base,
    id: `user-${index}`,
    type: "userMessage" as const,
    text: `Geometry prompt ${index}`,
    content: [],
    clientId: null,
  };
  const final = {
    ...base,
    id: `answer-${index}`,
    type: "agentMessage" as const,
    text: Array.from(
      { length: index % 4 === 1 ? 16 : 3 },
      (_, paragraph) =>
        `Response ${index}, paragraph ${paragraph}. A deterministic paragraph with enough words to wrap differently when the viewport narrows. Reader identity must survive measured layout changes.`,
    ).join("\n\n"),
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  const items = [
    prompt,
    ...(index === 60
      ? [
          {
            ...base,
            id: `tool-${index}`,
            type: "commandExecution" as const,
            command: "echo geometry",
            commandArgs: null,
            cwd: "/fixture",
            commandActions: [],
            processId: null,
            source: null,
            status: "completed" as const,
            output: "large output\n".repeat(2000),
            exitCode: 0,
            durationMs: 1,
          },
        ]
      : []),
    final,
  ];
  return {
    turnId: `geometry-${index}`,
    physicalRolloutId: "physical",
    historyEpoch: "epoch",
    contentRevision: "A",
    order: index,
    status: "completed",
    startedAt: null,
    completedAt: null,
    durationMs: 1,
    opening: { itemId: prompt.id, item: prompt, availability: "available" },
    items: items.map((item, ordinal) => ({
      itemId: item.id,
      item,
      physicalRolloutId: "physical",
      ordinal: index * 10 + ordinal,
      updatedAtOrdinal: index * 10 + ordinal,
      detail: "full",
    })),
    itemsView: "full",
    beforeCursor: null,
    afterCursor: null,
    loadedRanges: [
      {
        physicalRolloutId: "physical",
        startOrdinal: index * 10,
        endOrdinalExclusive: index * 10 + items.length,
      },
    ],
    coverage: { status: "complete", segments: [], gaps: [] },
    finalAnswerItemId: final.id,
  };
}
function pageWindow(start: number, end: number): HistoryPage {
  return {
    threadId: sessionId,
    historyEpoch: "epoch",
    contentRevision: "A",
    metadataRevision: "M",
    turns: Array.from({ length: end - start }, (_, i) => historyWindow(start + i)),
    beforeCursor: start > 0 ? String(start) : null,
    afterCursor: end < 120 ? String(end) : null,
    coverage: { status: "partial", segments: [], gaps: [] },
    preparation: "partial",
  };
}
async function top(anchor: Locator) {
  return anchor.evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      element.closest(".progressive-conversation")!.getBoundingClientRect().top,
  );
}

test("progressive measured anchor survives prepend, reader movement, rich growth, expansion and child resize with bounded DOM", async ({
  page,
  goto,
}) => {
  let releaseBefore!: () => void;
  let beforeRequested = false;
  const gate = new Promise<void>((resolve) => {
    releaseBefore = resolve;
  });
  let latestEnd = 120;
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      forward = () =>
        this.dispatchEvent(
          new MessageEvent("session.updated", {
            data: JSON.stringify({
              type: "session.updated",
              ids: ["77777777-7777-4777-8777-777777777777"],
              revision: "changed",
            }),
          }),
        );
      constructor() {
        super();
        window.addEventListener("viewport-invalidate", this.forward);
      }
      close() {
        window.removeEventListener("viewport-invalidate", this.forward);
      }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: FixtureEvents });
  });
  let richActive = 0;
  let richPeak = 0;
  await page.route("**/api/history/presentation", async (route) => {
    const query = route.request().postDataJSON();
    richPeak = Math.max(richPeak, ++richActive);
    const parsed = await parseRichText(query.markdown);
    richActive--;
    await route.fulfill({ json: { ...query, body: parsed.document } });
  });
  await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/navigator")) {
      return route.fulfill({ json: historyNavigatorPage(pageWindow(0, 5)) });
    }
    if (url.pathname.endsWith("/turns")) {
      const query = JSON.parse(url.searchParams.get("history")!);
      if (query.anchor.kind === "before") {
        beforeRequested = true;
        await gate;
        return route.fulfill({
          json: pageWindow(
            Math.max(0, Number(query.anchor.cursor) - 20),
            Number(query.anchor.cursor),
          ),
        });
      }
      if (query.anchor.kind === "after") {
        return route.fulfill({
          json: pageWindow(
            Number(query.anchor.cursor),
            Math.min(120, Number(query.anchor.cursor) + 20),
          ),
        });
      }
      if (query.anchor.kind === "turn") {
        const index = Number(query.anchor.turnId.split("-").at(-1));
        return route.fulfill({
          json: pageWindow(Math.max(0, index - 1), Math.min(120, index + 4)),
        });
      }
      return route.fulfill({ json: pageWindow(latestEnd - 5, latestEnd) });
    }
    return route.fulfill({
      json: {
        id: sessionId,
        sourcePath: null,
        cwd: null,
        gitBranch: null,
        gitSha: null,
        gitOriginUrl: null,
        revision: "A",
        title: "Progressive geometry",
        scope: "active",
        createdAt: "2026-10-29T00:00:00Z",
        updatedAt: "2026-10-29T00:00:00Z",
        parentThreadId: null,
        childThreadIds: [],
        pinned: false,
        sectionName: null,
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await goto(`/session/${sessionId}?progressive=1&turn=geometry-61`, { waitUntil: "hydration" });
  const scroller = page.locator(".progressive-conversation");
  const anchor = scroller.locator('[data-history-turn="geometry-61"]');
  await expect(anchor).toBeVisible();
  await expect.poll(async () => Math.abs(await top(anchor))).toBeLessThanOrEqual(3);
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 80 }));
    element.scrollTop += 80;
  });
  await expect.poll(async () => Math.abs((await top(anchor)) + 80)).toBeLessThanOrEqual(3);
  await page.getByRole("button", { name: "Load older turns", exact: true }).evaluate((element) => {
    if (element instanceof HTMLButtonElement) {
      element.click();
    }
  });
  await expect.poll(() => beforeRequested).toBe(true);
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 96 }));
    element.scrollTop += 96;
  });
  await expect.poll(async () => Math.abs((await top(anchor)) + 176)).toBeLessThanOrEqual(3);
  const readingTop = await top(anchor);
  releaseBefore();
  await expect(scroller).toHaveAttribute("data-retained-turns", "25");
  await expect.poll(async () => Math.abs((await top(anchor)) - readingTop)).toBeLessThanOrEqual(3);
  await expect(scroller.locator('[data-history-turn="geometry-60"]')).toBeAttached();
  const work = scroller
    .locator('[data-history-turn="geometry-60"] .conversation-work-stream')
    .first();
  await work.locator(":scope > summary").evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    if (element instanceof HTMLElement) {
      element.click();
    }
  });
  await expect(work).toHaveAttribute("open", "");
  await expect.poll(async () => Math.abs((await top(anchor)) - readingTop)).toBeLessThanOrEqual(3);
  await scroller.evaluate((element) => {
    const previous = element.querySelector('[data-history-turn="geometry-60"]')!;
    const image = document.createElement("img");
    image.alt = "Late geometry image";
    image.style.cssText = "display:block;width:300px;height:350px";
    image.src =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="350"><rect width="300" height="350" fill="navy"/></svg>',
      );
    previous.append(image);
  });
  await expect.poll(async () => Math.abs((await top(anchor)) - readingTop)).toBeLessThanOrEqual(3);
  await page.getByRole("button", { name: "Resize child panel" }).click();
  await expect.poll(async () => Math.abs((await top(anchor)) - readingTop)).toBeLessThanOrEqual(3);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(async () => Math.abs((await top(anchor)) - readingTop)).toBeLessThanOrEqual(3);
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect.poll(async () => Math.abs((await top(anchor)) - readingTop)).toBeLessThanOrEqual(3);
  await page.getByRole("button", { name: "Clear navigation target" }).click();
  await page.getByRole("button", { name: "Toggle chat" }).click();
  await expect(scroller).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle chat" }).click();
  await expect(anchor).toBeVisible();
  await expect.poll(async () => Math.abs((await top(anchor)) - readingTop)).toBeLessThanOrEqual(3);
  latestEnd = 121;
  await page.evaluate(() => window.dispatchEvent(new Event("viewport-invalidate")));
  await expect(scroller).toHaveAttribute("data-retained-turns", "10");
  await expect.poll(async () => Math.abs((await top(anchor)) - readingTop)).toBeLessThanOrEqual(3);
  expect(await scroller.locator("[data-history-turn]").count()).toBeLessThan(20);
  expect(richPeak).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Distant target", exact: true }).click();
  const distant = scroller.locator('[data-history-turn="geometry-0"]');
  await expect(distant).toBeVisible();
  await expect.poll(async () => Math.abs(await top(distant))).toBeLessThanOrEqual(3);
  const distantTop = await top(distant);
  await page.getByRole("button", { name: "Latest content", exact: true }).click();
  await expect(scroller.locator('[data-history-turn="geometry-120"]')).toBeVisible();
  latestEnd = 122;
  await page.evaluate(() => window.dispatchEvent(new Event("viewport-invalidate")));
  await expect(scroller.locator('[data-history-turn="geometry-121"]')).toBeVisible();
  await expect
    .poll(() =>
      scroller.evaluate((element) =>
        Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight),
      ),
    )
    .toBeLessThanOrEqual(3);
  console.log(
    JSON.stringify({
      readingTop,
      distantTop,
      mountedTurns: await scroller.locator("[data-history-turn]").count(),
      retainedTurns: await scroller.getAttribute("data-retained-turns"),
      richPeak,
    }),
  );
});
