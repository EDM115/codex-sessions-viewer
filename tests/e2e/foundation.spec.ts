import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@nuxt/test-utils/playwright";

declare global {
  interface Window {
    emitViewerEvent: (type: string, data: string) => void;
    viewerEventListenerCount: () => number;
  }
}

test("serves rendered HTML", async ({ request }) => {
  const response = await request.get("/");

  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain("Preparing your local archive…");
  expect(html).toContain(
    "The page is ready while the viewer reconciles session metadata and cached conversation payloads in the background.",
  );
});

test("hydrates and performs client-side navigation", async ({ page, goto }) => {
  await goto("/", { waitUntil: "hydration" });
  await page.getByRole("link", { name: "Open Settings" }).click();

  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Settings are explicit, local, and reversible.",
  );
  await page.getByRole("link", { name: "Open session library" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("opens an exact turn with the virtualized timeline, minimap, and inspector", async ({
  page,
  goto,
}) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  await goto(`/session/${sessionId}?turn=turn-1#turn-turn-1`, { waitUntil: "hydration" });

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Build the parser");
  await expect(page.locator(".conversation-message--user").first()).toContainText(
    "Build the parser",
  );
  await expect(page.locator(".conversation-message--assistant").first()).toContainText(
    "The parser is ready.",
  );
  await expect(page.getByRole("navigation", { name: "Conversation turns" })).toBeVisible();
  await expect
    .poll(() => page.locator(".conversation-timeline [data-turn-id]").count())
    .toBeLessThan(20);
  await page
    .getByText(/Agent work/)
    .first()
    .click();
  await expect(page.getByText("filesystem/read_file")).toBeVisible();
  const infoButton = page.getByRole("button", { name: "Open message info" }).first();
  await infoButton.click();
  await expect(page.getByRole("dialog", { name: "Info" })).toContainText("gpt-exact-1");
  await expect(
    page.getByRole("dialog", { name: "Info" }).getByText("final", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Preserved raw protocol records")).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole("dialog", { name: "Info" }).press("Escape");
  await expect(infoButton).toBeFocused();
});

test("preserves a moved reading anchor while a deferred earlier chunk is applied", async ({
  page,
  goto,
}) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let releaseEarlierChunk!: () => void;
  let earlierChunkRequested = false;
  const earlierChunkGate = new Promise<void>((resolve) => {
    releaseEarlierChunk = resolve;
  });
  await page.route(`**/api/sessions/${sessionId}/turns?cursor=0*`, async (route) => {
    earlierChunkRequested = true;
    await earlierChunkGate;
    await route.continue();
  });
  await goto(`/session/${sessionId}?turn=turn-21#turn-turn-21`, { waitUntil: "hydration" });
  const scroller = page.locator(".conversation-timeline");
  const anchorTurn = page.locator('.conversation-turn[data-turn-id="turn-21"]');
  await expect(anchorTurn).toBeVisible();
  await page.getByRole("button", { name: "Load earlier turns" }).evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => earlierChunkRequested).toBe(true);
  await scroller.evaluate((element) => {
    element.scrollTop += 96;
  });
  const before = await anchorTurn.boundingBox();
  expect(before).not.toBeNull();

  releaseEarlierChunk();
  await expect(page.getByRole("button", { name: "Load earlier turns" })).toBeHidden();
  await expect(anchorTurn).toBeVisible();
  await expect
    .poll(async () => {
      const after = await anchorTurn.boundingBox();
      return Math.abs((after?.y ?? 0) - (before?.y ?? 0));
    })
    .toBeLessThanOrEqual(3);
});

test("jumps across chunks from the narrow minimap and restores keyboard focus", async ({
  page,
  goto,
}) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  await page.setViewportSize({ width: 390, height: 800 });
  await goto(`/session/${sessionId}?turn=turn-1#turn-turn-1`, { waitUntil: "hydration" });
  const toggle = page.getByRole("button", { name: "Open turn minimap" });

  await toggle.click();
  await expect(page.getByRole("button", { name: /Turn 1:/ })).toBeFocused();
  await page.getByRole("button", { name: /Turn 1:/ }).press("End");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/turn=turn-25/);
  await expect(page.getByText("Review timeline turn 25", { exact: true })).toBeVisible();

  await toggle.click();
  await page.getByRole("button", { name: /Turn 21:/ }).click();
  await expect(page).toHaveURL(/turn=turn-21/);
  await expect(
    page.getByText("Keep the tall timeline turn active while reading", { exact: true }),
  ).toBeVisible();
  const tallTurn = page.locator('.conversation-turn[data-turn-id="turn-21"]');
  const tallMarker = page.locator('.turn-minimap__target[data-turn-id="turn-21"]');
  await expect(tallMarker).toHaveAttribute("aria-current", "true");
  await expect.poll(async () => (await tallTurn.boundingBox())?.height ?? 0).toBeGreaterThan(800);
  await page.locator(".conversation-timeline").evaluate((element) => {
    element.scrollTop += 300;
  });
  await expect(tallMarker).toHaveAttribute("aria-current", "true");
});

test("coalesces bursty live invalidations without console errors", async ({ page, goto }) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  await page.addInitScript(() => {
    const listeners = new Map<string, EventListener[]>();
    class MockEventSource {
      addEventListener(type: string, listener: EventListener): void {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      }

      close(): void {
        listeners.clear();
      }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: MockEventSource });
    Object.defineProperty(window, "viewerEventListenerCount", {
      configurable: true,
      value: (): number =>
        [...listeners.values()].reduce((total, items) => total + items.length, 0),
    });
    Object.defineProperty(window, "emitViewerEvent", {
      configurable: true,
      value: (type: string, data: string): void => {
        for (const listener of listeners.get(type) ?? []) {
          listener(new MessageEvent(type, { data }));
        }
      },
    });
  });
  const consoleErrors: string[] = [];
  const summaryRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/sessions/${sessionId}`) {
      summaryRequests.push(url.href);
    }
  });
  await goto(`/session/${sessionId}?turn=turn-21`, { waitUntil: "hydration" });
  await expect
    .poll(() => page.evaluate(() => window.viewerEventListenerCount()))
    .toBeGreaterThan(0);

  await page.evaluate((id) => {
    const event = JSON.stringify({
      type: "session.updated",
      ids: [id],
      revision: "revision-burst",
    });
    const emit = window.emitViewerEvent;
    for (let index = 0; index < 5; index += 1) {
      emit("session.updated", event);
    }
  }, sessionId);

  await expect.poll(() => summaryRequests.length).toBe(2);
  expect(consoleErrors).toEqual([]);
});
