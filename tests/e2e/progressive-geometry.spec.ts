import { fileURLToPath } from "node:url";

import { expect, test } from "@nuxt/test-utils/playwright";
import type { Locator, Page } from "@playwright/test";

import { parseRichText } from "#server/content/parseRichText.ts";
import {
  historyNavigatorPage,
  type HistoryPage,
  type HistoryTurnWindow,
} from "#shared/types/history.ts";
import type { HistoryItemQuery, HistoryPageQuery } from "#shared/types/repository.ts";

test.use({
  nuxt: {
    rootDir: fileURLToPath(new URL("../fixtures/nuxt-viewport", import.meta.url)),
    dev: false,
    host: process.env["CODEX_VIEWER_TEST_URL"],
    build: true,
  },
});

for (const [name, source] of [
  [
    "line limit",
    Array.from({ length: 2000 }, (_, index) => `const value${index} = '<source & literal>';`).join(
      "\n",
    ),
  ],
  ["character limit", `const value = '${"plain <source> & ".repeat(8000)}';`],
] as const) {
  test(`giant code keeps exact plain source and bounded DOM at the ${name}`, async ({
    context,
    page,
    goto,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
      const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text) => {
        sessionStorage.setItem("giant-code-copy", text);
        return writeText(text);
      };
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
      const pathname = new URL(route.request().url()).pathname;
      const result = pageWindow(0, 5);
      result.afterCursor = null;
      const final = result.turns[0]?.items.at(-1)?.item;
      const control = result.turns[1]?.items.at(-1)?.item;
      if (final?.type !== "agentMessage" || control?.type !== "agentMessage") {
        throw new Error("Expected final message fixtures");
      }
      final.text = `\`\`\`ts\n${source}\n\`\`\``;
      control.text = "```ts\nconst answer: number = 42\n```";
      if (pathname.endsWith("/navigator")) {
        return route.fulfill({ json: historyNavigatorPage(result) });
      }
      if (pathname.endsWith("/turns")) {
        return route.fulfill({ json: result });
      }
      return route.fulfill({
        json: {
          id: sessionId,
          title: "Giant code",
          scope: "active",
          createdAt: null,
          updatedAt: null,
          sourcePath: null,
          cwd: null,
          gitBranch: null,
          gitSha: null,
          gitOriginUrl: null,
          revision: "A",
          parentThreadId: null,
          childThreadIds: [],
          pinned: false,
          sectionName: null,
        },
      });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await goto(`/session/${sessionId}?progressive=1&turn=geometry-0`, { waitUntil: "hydration" });
    const scroller = page.locator(".progressive-conversation");
    const anchor = scroller.locator('[data-history-turn="geometry-0"]');
    const block = anchor.locator(".rich-code-block");
    const code = block.locator("pre > code");
    await expect(code).toHaveCount(1);
    expect(await code.textContent()).toBe(source);
    await expect(code.locator("*")).toHaveCount(0);
    expect(await code.evaluate((element) => element.childNodes.length)).toBe(1);
    await expect.poll(async () => Math.abs(await top(anchor))).toBeLessThanOrEqual(3);
    await block.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect(
      block.getByRole("button", { name: "Copied: Copy code", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("giant-code-copy"))).toBe(source);
    // Windows clipboard text uses CRLF, the source passed into the native API remains exact
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n"),
    ).toBe(source);
    await block.getByRole("button", { name: "Wrap code", exact: true }).click();
    await page.setViewportSize({ width: 375, height: 900 });
    await expect.poll(async () => Math.abs(await top(anchor))).toBeLessThanOrEqual(3);
    await expect(code.locator("*")).toHaveCount(0);
    expect(await code.textContent()).toBe(source);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await scroller.locator("[data-history-turn]").count()).toBeLessThanOrEqual(5);
    expect(await scroller.locator("*").count()).toBeLessThan(1000);
    expect(richPeak).toBeLessThanOrEqual(2);
    console.log(
      JSON.stringify({
        name,
        characters: source.length,
        lines: source.split("\n").length,
        codeElements: await code.locator("*").count(),
        mountedElements: await scroller.locator("*").count(),
        anchorTop: await top(anchor),
        richPeak,
      }),
    );
  });
}
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
  let readingTop = await top(anchor);
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
  const readingMessageId = await anchor.locator("[data-message-id]").evaluateAll((elements) =>
    elements
      .find((element) => {
        const readingLine = element
          .closest(".progressive-conversation")!
          .getBoundingClientRect().top;
        const rect = element.getBoundingClientRect();
        return rect.top <= readingLine && rect.bottom > readingLine;
      })
      ?.getAttribute("data-message-id"),
  );
  expect(readingMessageId).toBeTruthy();
  const readingMessage = anchor.locator(`[data-message-id="${readingMessageId}"]`);
  const measureReading = () =>
    readingMessage.evaluate((element) => {
      const surfaceTop = element.closest(".progressive-conversation")!.getBoundingClientRect().top;
      const turn = element.closest(".conversation-turn")!;
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-message-id"),
        top: rect.top - surfaceTop,
        bottom: rect.bottom - surfaceTop,
        turnTop: turn.getBoundingClientRect().top - surfaceTop,
        padding: getComputedStyle(turn).paddingTop,
      };
    });
  const beforeResize = await measureReading();
  expect(beforeResize.top).toBeLessThanOrEqual(0);
  expect(beforeResize.bottom).toBeGreaterThan(0);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect
    .poll(async () => Math.abs((await top(readingMessage)) - beforeResize.top))
    .toBeLessThanOrEqual(3);
  readingTop = await top(anchor);
  const afterResize = await measureReading();
  expect(afterResize.id).toBe(beforeResize.id);
  expect(afterResize.top).toBeLessThanOrEqual(0);
  expect(afterResize.bottom).toBeGreaterThan(0);
  console.log(JSON.stringify({ responsiveReading: { before: beforeResize, after: afterResize } }));
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

async function installHistoryReader(
  page: Page,
  read: (query: HistoryPageQuery | HistoryItemQuery) => Promise<HistoryPage | HistoryTurnWindow>,
  navigation = pageWindow(0, 5),
) {
  await page.route("**/api/history/presentation", async (route) => {
    const query = route.request().postDataJSON();
    const body = (await parseRichText(query.markdown)).document;
    await route.fulfill({ json: { ...query, body } });
  });
  await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/navigator")) {
      return route.fulfill({ json: historyNavigatorPage(navigation) });
    }
    if (url.pathname.endsWith("/turns") || url.pathname.endsWith("/items")) {
      return route.fulfill({ json: await read(JSON.parse(url.searchParams.get("history")!)) });
    }
    return route.fulfill({
      json: {
        id: sessionId,
        title: "Ownership geometry",
        scope: "active",
        createdAt: null,
        updatedAt: null,
        sourcePath: null,
        cwd: null,
        gitBranch: null,
        gitSha: null,
        gitOriginUrl: null,
        revision: "A",
        parentThreadId: null,
        childThreadIds: [],
        pinned: false,
        sectionName: null,
      },
    });
  });
}

test("retains a distant target after sixty turns and preserves reader position when latest loading is cancelled", async ({
  page,
  goto,
}) => {
  let deferLatest = true;
  let latestRequested = false;
  let latestReleased = false;
  let releaseLatest!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseLatest = resolve;
  });
  await installHistoryReader(
    page,
    async (query) => {
      if (query.anchor.kind === "before") {
        const end = Number(query.anchor.cursor);
        return pageWindow(Math.max(0, end - query.limit!), end);
      }
      if (query.anchor.kind === "turn") {
        const index = Number(query.anchor.turnId.split("-").at(-1));
        return pageWindow(index, index + 5);
      }
      latestRequested = true;
      if (deferLatest) {
        await gate;
      }
      latestReleased = true;
      return pageWindow(115, 120);
    },
    pageWindow(100, 105),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await goto(`/session/${sessionId}?progressive=1&turn=geometry-100`, { waitUntil: "hydration" });
  const scroller = page.locator(".progressive-conversation");
  const reader = scroller.locator('[data-history-turn="geometry-100"]');
  await expect(reader).toBeVisible();
  await expect.poll(async () => Math.abs(await top(reader))).toBeLessThanOrEqual(3);
  for (const count of [25, 45, 60]) {
    // oxlint-disable-next-line no-await-in-loop -- Each page consumes the preceding source cursor
    await page.getByRole("button", { name: "Load older turns", exact: true }).evaluate((button) => {
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    });
    // oxlint-disable-next-line no-await-in-loop -- Assert the actual published window before requesting another page
    await expect(scroller).toHaveAttribute("data-retained-turns", String(count));
  }
  await page.getByRole("button", { name: "Distant target", exact: true }).click();
  const distant = scroller.locator('[data-history-turn="geometry-0"]');
  await expect(distant).toBeVisible();
  await expect.poll(async () => Math.abs(await top(distant))).toBeLessThanOrEqual(3);
  await expect(scroller).toHaveAttribute("data-retained-turns", "60");
  await page.getByRole("button", { name: "Geometry prompt 100", exact: true }).click();
  await expect(reader).toBeVisible();
  await expect.poll(async () => Math.abs(await top(reader))).toBeLessThanOrEqual(3);
  await page.getByRole("button", { name: "Latest content", exact: true }).click();
  await expect.poll(() => latestRequested).toBe(true);
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 96 }));
    element.scrollTop += 96;
  });
  await expect.poll(async () => Math.abs((await top(reader)) + 96)).toBeLessThanOrEqual(3);
  releaseLatest();
  await expect.poll(() => latestReleased).toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(reader).toBeVisible();
  await expect.poll(async () => Math.abs((await top(reader)) + 96)).toBeLessThanOrEqual(3);
  deferLatest = false;
  await page.getByRole("button", { name: "Latest content", exact: true }).click();
  await expect(scroller.locator('[data-history-turn="geometry-119"]')).toBeVisible();
  expect(await scroller.locator("[data-history-turn]").count()).toBeLessThan(20);
  console.log(
    JSON.stringify({
      retentionCrossing: 60,
      target: "geometry-0",
      targetOffset: 0,
      cancelledLatestReader: "geometry-100",
      cancelledLatestOffset: -96,
    }),
  );
});

test("preserves a lower entry through item prepend, earlier expansion and late growth inside one huge turn", async ({
  page,
  goto,
}) => {
  const initial = historyWindow(0);
  const opening = initial.items[0];
  const final = initial.items.at(-1);
  if (!opening || !final) {
    throw new Error("Expected opening and final source fixtures");
  }
  const sourceAnswer = final;
  function progress(id: string, ordinal: number, paragraphs = 8) {
    if (sourceAnswer.item?.type !== "agentMessage") {
      throw new Error("Expected source answer fixture");
    }
    return {
      ...sourceAnswer,
      itemId: id,
      ordinal,
      updatedAtOrdinal: ordinal,
      item: {
        ...sourceAnswer.item,
        id,
        phase: "commentary",
        text: Array.from(
          { length: paragraphs },
          (_, index) =>
            `${id} paragraph ${index}. ${"A visible source paragraph with a stable reading identity. ".repeat(8)}`,
        ).join("\n\n"),
      },
    };
  }
  const command = historyWindow(60).items.find((item) => item.item?.type === "commandExecution")!;
  const earlierMessage = progress("earlier-message", 101);
  earlierMessage.item.text += "\n\n```mermaid\ngraph TD\n  Before --> After\n```";
  initial.items = [
    opening,
    {
      ...command,
      itemId: "earlier-tool",
      ordinal: 100,
      updatedAtOrdinal: 100,
      item: command.item && { ...command.item, id: "earlier-tool" },
    },
    earlierMessage,
    progress("reading-item", 102),
    { ...final, ordinal: 103, updatedAtOrdinal: 103 },
  ];
  initial.beforeCursor = "older-items";
  initial.itemsView = "summary";
  initial.itemIslands = [
    [opening.itemId],
    ["earlier-tool", "earlier-message", "reading-item", final.itemId],
  ];
  initial.loadedRanges = [
    { physicalRolloutId: "physical", startOrdinal: 0, endOrdinalExclusive: 1 },
    { physicalRolloutId: "physical", startOrdinal: 100, endOrdinalExclusive: 104 },
  ];
  initial.coverage = {
    status: "partial",
    segments: [],
    gaps: [
      {
        physicalRolloutId: "physical",
        turnId: initial.turnId,
        reason: "Earlier items not loaded",
        beforeOrdinal: 1,
        afterOrdinal: 100,
      },
    ],
  };
  const result = { ...pageWindow(0, 1), turns: [initial], beforeCursor: null, afterCursor: null };
  let requested = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await installHistoryReader(
    page,
    async (query) => {
      if ("turnId" in query) {
        requested = true;
        await gate;
        return {
          ...initial,
          items: Array.from({ length: 20 }, (_, index) => progress(`older-${index}`, index + 1, 1)),
          beforeCursor: null,
          afterCursor: "back-to-tail",
          loadedRanges: [
            { physicalRolloutId: "physical", startOrdinal: 1, endOrdinalExclusive: 21 },
          ],
          itemIslands: [Array.from({ length: 20 }, (_, index) => `older-${index}`)],
        };
      }
      return result;
    },
    result,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await goto(`/session/${sessionId}?progressive=1&turn=geometry-0`, { waitUntil: "hydration" });
  const scroller = page.locator(".progressive-conversation");
  const work = scroller.locator(".conversation-work-stream").first();
  await work.locator(":scope > summary").click();
  const reading = scroller.locator('[data-entry-id="reading-item"]');
  await expect(reading.locator(".rich-text-document > p")).toHaveCount(8);
  await reading.evaluate((element) => {
    const surface = element.closest(".progressive-conversation")!;
    surface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 200 }));
    surface.scrollTop +=
      element.getBoundingClientRect().top - surface.getBoundingClientRect().top + 60;
  });
  await expect.poll(async () => Math.abs((await top(reading)) + 60)).toBeLessThanOrEqual(3);
  const identity = await reading.elementHandle();
  await page.getByRole("button", { name: "Load older items", exact: true }).evaluate((button) => {
    if (button instanceof HTMLButtonElement) {
      button.click();
    }
  });
  await expect.poll(() => requested).toBe(true);
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 96 }));
    element.scrollTop += 96;
  });
  await expect.poll(async () => Math.abs((await top(reading)) + 156)).toBeLessThanOrEqual(3);
  release();
  await expect(scroller).toHaveAttribute("data-retained-items", "25");
  await expect.poll(async () => Math.abs((await top(reading)) + 156)).toBeLessThanOrEqual(3);
  expect(await reading.evaluate((element, previous) => element === previous, identity)).toBe(true);
  await scroller.locator('[data-tool-group="earlier-tool"] > summary').evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    if (element instanceof HTMLElement) {
      element.click();
    }
  });
  await expect(scroller.locator('[data-tool-group="earlier-tool"]')).toHaveAttribute("open", "");
  await expect.poll(async () => Math.abs((await top(reading)) + 156)).toBeLessThanOrEqual(3);
  await scroller.locator('[data-entry-id="earlier-tool"] summary').evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    if (element instanceof HTMLElement) {
      element.click();
    }
  });
  await expect(scroller.locator('[data-entry-id="earlier-tool"] > details')).toHaveAttribute(
    "open",
    "",
  );
  await expect.poll(async () => Math.abs((await top(reading)) + 156)).toBeLessThanOrEqual(3);
  const diagram = scroller.locator('[data-entry-id="earlier-message"] .rich-mermaid');
  await diagram.getByRole("tab", { name: "Preview Mermaid diagram" }).evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    if (element instanceof HTMLElement) {
      element.click();
    }
  });
  await expect(diagram.locator("[data-mermaid-preview] svg")).toBeAttached();
  await expect.poll(async () => Math.abs((await top(reading)) + 156)).toBeLessThanOrEqual(3);
  await scroller.locator('[data-entry-id="earlier-message"]').evaluate((element) => {
    const image = document.createElement("img");
    image.alt = "Late same-turn image";
    image.style.cssText = "display:block;width:300px;height:350px";
    image.src =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="350"><rect width="300" height="350" fill="navy"/></svg>',
      );
    element.append(image);
  });
  await expect.poll(async () => Math.abs((await top(reading)) + 156)).toBeLessThanOrEqual(3);
  expect(await scroller.locator("[data-history-turn]").count()).toBe(1);
  console.log(
    JSON.stringify({
      sameTurn: "geometry-0",
      readingEntry: "reading-item",
      readingOffset: await top(reading),
      retainedItems: await scroller.getAttribute("data-retained-items"),
    }),
  );
});
