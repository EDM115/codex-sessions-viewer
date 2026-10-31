import { fileURLToPath } from "node:url";

import { expect, test } from "@nuxt/test-utils/playwright";

import { parseRichText } from "#server/content/parseRichText.ts";
import {
  historyNavigatorPage,
  type HistoryPage,
  type HistoryTurnWindow,
} from "#shared/types/history.ts";

test.use({
  nuxt: {
    rootDir: fileURLToPath(new URL("../fixtures/nuxt-viewport", import.meta.url)),
    dev: false,
    host: process.env["CODEX_VIEWER_TEST_URL"],
    build: true,
  },
});

const sessionId = "77777777-7777-4777-8777-777777777777";
function nativeWindow(index: number, revision: string): HistoryTurnWindow {
  const base = { startedAtMs: null, completedAtMs: null, evidence: { native: true } };
  const prompt = {
    ...base,
    id: `native-user-${index}`,
    type: "userMessage" as const,
    text: `Native prompt ${index}`,
    content: [],
    clientId: null,
  };
  const answer = {
    ...base,
    id: `native-answer-${index}`,
    type: "agentMessage" as const,
    text: Array.from(
      { length: index === 1 ? 18 : 3 },
      (_, paragraph) =>
        `Native answer ${index}, paragraph ${paragraph}. This deterministic text keeps the reader inside an older selected turn while newer history becomes available.`,
    ).join("\n\n"),
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  return {
    turnId: `native-${index}`,
    physicalRolloutId: "physical",
    historyEpoch: "native-epoch",
    contentRevision: revision,
    order: index * 2,
    decodedByteOrder: index * 100,
    status: "completed",
    startedAt: null,
    completedAt: null,
    durationMs: 1,
    opening: { itemId: prompt.id, item: prompt, availability: "available" },
    items: [prompt, answer].map((item, offset) => ({
      itemId: item.id,
      item,
      physicalRolloutId: "physical",
      ordinal: index * 2 + offset,
      updatedAtOrdinal: index * 2 + offset,
      decodedByteStart: index * 100 + offset * 40,
      decodedByteEnd: index * 100 + offset * 40 + 40,
      updatedAtDecodedByte: index * 100 + offset * 40,
      detail: "full",
    })),
    itemsView: "full",
    beforeCursor: null,
    afterCursor: null,
    loadedRanges: [
      {
        physicalRolloutId: "physical",
        startOrdinal: index * 2,
        endOrdinalExclusive: index * 2 + 2,
        startDecodedByte: index * 100,
        endDecodedByteExclusive: index * 100 + 80,
      },
    ],
    coverage: { status: "complete", segments: [], gaps: [] },
    finalAnswerItemId: answer.id,
  };
}

test("retains a native-shaped deep target and focused reader through automatic progress, then follows explicit Latest", async ({
  page,
  goto,
}) => {
  let revision = "A";
  let latestEnd = 25;
  const response = (target: boolean): HistoryPage => {
    const turns = target
      ? [nativeWindow(1, revision)]
      : Array.from({ length: 5 }, (_, index) => nativeWindow(latestEnd - 5 + index, revision));
    return {
      threadId: sessionId,
      historyEpoch: "native-epoch",
      contentRevision: revision,
      metadataRevision: "metadata",
      turns,
      beforeCursor: "older-native",
      afterCursor: target ? "newer-native" : null,
      preparation: "partial",
      coverage: {
        status: "partial",
        segments: [
          {
            physicalRolloutId: "physical",
            endOrdinalExclusive: null,
            endDecodedByteExclusive: null,
            coveredRanges: turns.flatMap((turn) => turn.loadedRanges),
            sourceWatermark: { nextOrdinal: latestEnd * 2, nextByteOffset: latestEnd * 100 },
            projectionWatermark: { nextOrdinal: latestEnd * 2, nextByteOffset: latestEnd * 100 },
          },
        ],
        gaps: [],
      },
    };
  };
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      forward = () =>
        this.dispatchEvent(
          new MessageEvent("session.updated", {
            data: JSON.stringify({
              type: "session.updated",
              ids: ["77777777-7777-4777-8777-777777777777"],
              revision: "notification",
            }),
          }),
        );
      constructor() {
        super();
        window.addEventListener("native-invalidate", this.forward);
      }
      close() {
        window.removeEventListener("native-invalidate", this.forward);
      }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: FixtureEvents });
  });
  await page.route("**/api/history/presentation", async (route) => {
    const query = route.request().postDataJSON();
    const body = (await parseRichText(query.markdown)).document;
    await route.fulfill({ json: { ...query, body } });
  });
  await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/navigator")) {
      return route.fulfill({ json: historyNavigatorPage(response(false)) });
    }
    if (url.pathname.endsWith("/turns")) {
      const query = JSON.parse(url.searchParams.get("history")!);
      return route.fulfill({ json: response(query.anchor.kind === "turn") });
    }
    return route.fulfill({
      json: {
        id: sessionId,
        title: "Native reader intent",
        scope: "active",
        createdAt: null,
        updatedAt: null,
        sourcePath: null,
        cwd: null,
        gitBranch: null,
        gitSha: null,
        gitOriginUrl: null,
        revision: "metadata",
        parentThreadId: null,
        childThreadIds: [],
        pinned: false,
        sectionName: null,
      },
    });
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  await goto(`/session/${sessionId}?progressive=1&turn=native-1`, { waitUntil: "hydration" });
  const surface = page.locator(".progressive-conversation");
  const target = surface.locator('[data-history-turn="native-1"]');
  const message = target.locator('[data-message-id="native-answer-1"]');
  const focused = message.getByRole("button", { name: "Copy assistant message", exact: true });
  await expect(message).toContainText("Native answer 1");
  const latestControl = page.getByRole("button", { name: "Latest content", exact: true });
  await expect(latestControl).toBeVisible();
  const actionBounds = await latestControl.evaluate((element) => {
    const action = element.getBoundingClientRect();
    const timeline = document.querySelector(".progressive-conversation")!.getBoundingClientRect();
    return { actionTop: action.top, timelineBottom: timeline.bottom };
  });
  expect(actionBounds.actionTop).toBeGreaterThanOrEqual(actionBounds.timelineBottom);
  await surface.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1000 }));
    element.scrollTop = element.scrollHeight;
  });
  await expect(focused).toBeVisible();
  await focused.focus();
  const offset = () =>
    message.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest(".progressive-conversation")!.getBoundingClientRect().top,
    );
  const readingTop = await offset();
  await page.evaluate(() => window.dispatchEvent(new Event("native-invalidate")));
  await expect(surface).toHaveAttribute("data-retained-turns", "6");
  await expect(focused).toBeFocused();
  await expect.poll(async () => Math.abs((await offset()) - readingTop)).toBeLessThanOrEqual(3);
  revision = "B";
  latestEnd = 26;
  await page.evaluate(() => window.dispatchEvent(new Event("native-invalidate")));
  await expect(surface).toHaveAttribute("data-retained-turns", "7");
  await expect(page.getByRole("navigation", { name: "Loaded turn navigation" })).toContainText(
    "Native prompt 25",
  );
  await expect(focused).toBeFocused();
  await expect.poll(async () => Math.abs((await offset()) - readingTop)).toBeLessThanOrEqual(3);
  await expect(target).toContainText(
    "Previously loaded item details are awaiting source verification.",
  );
  await page.getByRole("button", { name: "Latest content", exact: true }).click();
  await expect(surface.locator('[data-history-turn="native-25"]')).toBeVisible();
  revision = "C";
  latestEnd = 27;
  await page.evaluate(() => window.dispatchEvent(new Event("native-invalidate")));
  await expect(surface.locator('[data-history-turn="native-26"]')).toBeVisible();
  await expect
    .poll(() =>
      surface.evaluate((element) =>
        Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight),
      ),
    )
    .toBeLessThanOrEqual(3);
});

test.describe("nested scroll ownership", () => {
  test.use({ hasTouch: true });
  for (const gesture of ["wheel", "touch"] as const) {
    test(`keeps nested horizontal ${gesture} separate from owned outer adjustment and follows real outer input`, async ({
      page,
      goto,
    }) => {
      let revision = "A";
      let appended = false;
      const added = "New paragraph above the retained reading position.";
      const response = (): HistoryPage => {
        const turns = [nativeWindow(0, revision), nativeWindow(1, revision)];
        const first = turns[0]!.items.at(-1)!.item;
        const last = turns[1]!.items.at(-1)!.item;
        if (first?.type !== "agentMessage" || last?.type !== "agentMessage") {
          throw new Error("Expected native message fixtures");
        }
        first.text = revision === "A" ? "Earlier content." : `Earlier content.\n\n${added}`;
        last.text = `${last.text}\n\n\`\`\`text\n${"horizontal source ".repeat(120)}\n\`\`\``;
        if (appended) {
          turns.push(nativeWindow(2, revision));
        }
        return {
          threadId: sessionId,
          historyEpoch: "native-epoch",
          contentRevision: revision,
          metadataRevision: "metadata",
          turns,
          beforeCursor: null,
          afterCursor: null,
          preparation: "ready",
          coverage: { status: "complete", segments: [], gaps: [] },
        };
      };
      const failures: string[] = [];
      const external: string[] = [];
      let origin: string | null = null;
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          failures.push(message.text());
        }
      });
      page.on("request", (request) => {
        const location = new URL(request.url());
        if (request.resourceType() === "document") {
          origin ??= location.origin;
        }
        if (origin && /^https?:$/u.test(location.protocol) && location.origin !== origin) {
          external.push(request.url());
        }
      });
      await page.addInitScript(() => {
        class FixtureEvents extends EventTarget {
          forward = () =>
            this.dispatchEvent(
              new MessageEvent("session.updated", {
                data: JSON.stringify({
                  type: "session.updated",
                  ids: ["77777777-7777-4777-8777-777777777777"],
                  revision: "notification",
                }),
              }),
            );
          constructor() {
            super();
            window.addEventListener("nested-invalidate", this.forward);
          }
          close() {
            window.removeEventListener("nested-invalidate", this.forward);
          }
        }
        Object.defineProperty(window, "EventSource", { configurable: true, value: FixtureEvents });
      });
      await page.route("**/api/history/presentation", async (route) => {
        const query = route.request().postDataJSON();
        const body = (await parseRichText(query.markdown)).document;
        await route.fulfill({ json: { ...query, body } });
      });
      await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith("/navigator")) {
          return route.fulfill({ json: historyNavigatorPage(response()) });
        }
        if (pathname.endsWith("/turns")) {
          return route.fulfill({ json: response() });
        }
        return route.fulfill({
          json: {
            id: sessionId,
            title: "Nested reader input",
            scope: "active",
            createdAt: null,
            updatedAt: null,
            sourcePath: null,
            cwd: null,
            gitBranch: null,
            gitSha: null,
            gitOriginUrl: null,
            revision: "metadata",
            parentThreadId: null,
            childThreadIds: [],
            pinned: false,
            sectionName: null,
          },
        });
      });
      await page.setViewportSize({ width: 1100, height: 900 });
      await goto(`/session/${sessionId}?progressive=1`, { waitUntil: "hydration" });
      const surface = page.locator(".progressive-conversation");
      const message = surface.locator('[data-message-id="native-answer-1"]');
      const nested = message.locator(".rich-code-block__scroller");
      await expect(nested).toBeVisible();
      await expect
        .poll(() => nested.evaluate((element) => element.scrollWidth > element.clientWidth))
        .toBe(true);
      const latest = page.getByRole("button", { name: "Latest content", exact: true });
      await page.evaluate(() => document.fonts.ready);
      await expect(latest).toBeHidden();
      await expect
        .poll(() =>
          surface.evaluate((element) =>
            Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
          ),
        )
        .toBeLessThanOrEqual(3);
      await surface.evaluate((element) => {
        element.scrollTop = element.scrollHeight - element.clientHeight - 40;
      });
      await expect(latest).toBeVisible();
      const before = await surface.evaluate((element) => ({
        top: element.scrollTop,
        gap: element.scrollHeight - element.clientHeight - element.scrollTop,
      }));
      expect(before.gap).toBe(40);
      const geometry = () =>
        message.evaluate((element) => {
          const container = element.closest(".progressive-conversation")!;
          const row = element.closest("[data-anchor-source]")!;
          const bounds = element.getBoundingClientRect();
          const surfaceBounds = container.getBoundingClientRect();
          return {
            top: container.scrollTop,
            height: container.scrollHeight,
            client: container.clientHeight,
            origin: container.getAttribute("data-history-origin"),
            source: row.getAttribute("data-anchor-source"),
            messageId: element.getAttribute("data-message-id"),
            messageTop: bounds.top,
            messageHeight: bounds.height,
            surfaceTop: surfaceBounds.top,
            relativeTop: bounds.top - surfaceBounds.top,
            rowTop: row.getBoundingClientRect().top,
            rowHeight: row.getBoundingClientRect().height,
            entries: [
              ...row.querySelectorAll<HTMLElement>(
                "[data-anchor-entry], [data-message-id], [data-entry-id]",
              ),
            ].map((entry) => ({
              key:
                entry.dataset["anchorEntry"] ??
                entry.dataset["messageId"] ??
                entry.dataset["entryId"],
              top: entry.getBoundingClientRect().top - surfaceBounds.top,
              bottom: entry.getBoundingClientRect().bottom - surfaceBounds.top,
            })),
          };
        });
      const geometryBefore = await geometry();
      const reading = await message.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest(".progressive-conversation")!.getBoundingClientRect().top,
      );
      const bounds = await nested.boundingBox();
      if (!bounds) {
        throw new Error("Expected the actual visible code scroller");
      }
      const point = { x: bounds.x + bounds.width * 0.75, y: bounds.y + bounds.height / 2 };
      if (gesture === "wheel") {
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(180, 0);
      } else {
        const session = await page.context().newCDPSession(page);
        await session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [point],
        });
        const moveTouch = async (offset: number) => {
          await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: point.x - offset, y: point.y }],
          });
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
          );
        };
        await moveTouch(30);
        await moveTouch(90);
        await moveTouch(180);
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await session.detach();
      }
      await expect.poll(() => nested.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      expect(await surface.evaluate((element) => element.scrollTop)).toBe(before.top);
      revision = "B";
      await page.evaluate(() => window.dispatchEvent(new Event("nested-invalidate")));
      await expect(surface).toContainText(added);
      try {
        await expect
          .poll(() => surface.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(before.top);
      } catch (error) {
        console.log(
          JSON.stringify({
            condition: "nested-owned-adjustment",
            gesture,
            before: geometryBefore,
            after: await geometry(),
            latestVisible: await latest.isVisible(),
          }),
        );
        throw error;
      }
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect
        .poll(async () =>
          Math.abs(
            (await message.evaluate(
              (element) =>
                element.getBoundingClientRect().top -
                element.closest(".progressive-conversation")!.getBoundingClientRect().top,
            )) - reading,
          ),
        )
        .toBeLessThanOrEqual(3);
      await expect(latest).toBeVisible();
      await surface.hover();
      await page.mouse.wheel(0, 240);
      await expect
        .poll(() =>
          surface.evaluate((element) =>
            Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
          ),
        )
        .toBeLessThanOrEqual(3);
      await expect(latest).toBeHidden();
      revision = "C";
      appended = true;
      await page.evaluate(() => window.dispatchEvent(new Event("nested-invalidate")));
      await expect(surface.locator('[data-history-turn="native-2"]')).toBeVisible();
      await expect
        .poll(() =>
          surface.evaluate((element) =>
            Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
          ),
        )
        .toBeLessThanOrEqual(3);
      expect(failures).toEqual([]);
      expect(external).toEqual([]);
    });
  }
});
