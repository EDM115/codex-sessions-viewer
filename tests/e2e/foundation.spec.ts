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
  const sentinel = await page.evaluate(() => {
    const token = crypto.randomUUID();
    Object.defineProperty(window, "navigationSentinel", { value: token });
    return token;
  });
  await page.getByRole("link", { name: "Open Settings" }).click();

  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Settings are explicit, local, and reversible.",
  );
  await page.getByRole("link", { name: "Open session library" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => Reflect.get(window, "navigationSentinel"))).toBe(sentinel);
});

test("keeps active and archived search scoped in the URL and opens exact turns", async ({
  page,
  goto,
}) => {
  await goto("/", { waitUntil: "hydration" });
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  await expect(search).toBeVisible();
  await search.fill("Handle cancellation");
  await expect(page).toHaveURL(/\?q=Handle\+cancellation$/u);
  await expect(page.getByText("1 result for “Handle cancellation”")).toBeAttached();
  const activeResult = page
    .locator('[aria-label="Search results"]')
    .getByRole("link", { name: /Build the parser/u });
  await expect(activeResult).toHaveAttribute(
    "href",
    "/session/11111111-1111-4111-8111-111111111111?q=Handle+cancellation&turn=turn-2#turn-turn-2",
  );
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documents.push(request.url());
    }
  });
  await activeResult.click();
  await expect(page).toHaveURL(
    /\/session\/11111111-1111-4111-8111-111111111111\?q=Handle\+cancellation&turn=turn-2/u,
  );
  await expect(
    page.getByLabel("Conversation timeline").getByText("Handle cancellation", { exact: true }),
  ).toBeVisible();
  expect(documents).toEqual([]);
  await expect(search).toHaveValue("Handle cancellation");

  await goto("/?scope=archived&q=Legacy+prompt", { waitUntil: "hydration" });
  await expect(page.getByRole("tab", { name: /Archived/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Search unloaded conversations" }).click();
  await expect(page.getByText("1 result for “Legacy prompt”")).toBeAttached();
  const archivedResult = page
    .locator('[aria-label="Search results"]')
    .getByRole("link", { name: /Legacy prompt/u });
  await expect(archivedResult).toHaveAttribute(
    "href",
    "/session/33333333-3333-4333-8333-333333333333?scope=archived&q=Legacy+prompt&turn=legacy-turn#turn-legacy-turn",
  );
  await archivedResult.click();
  await expect(page).toHaveURL(
    /\/session\/33333333-3333-4333-8333-333333333333\?scope=archived&q=Legacy\+prompt&turn=legacy-turn/u,
  );
  await expect(
    page.getByLabel("Conversation timeline").getByText("Legacy prompt", { exact: true }),
  ).toBeVisible();
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
    .getByText(/Worked for/)
    .first()
    .click();
  const toolGroup = page.locator(".conversation-tool-group").first();
  await expect(toolGroup).toBeVisible();
  await expect(toolGroup.locator(".conversation-tool-row")).toHaveCount(0);
  await toolGroup.locator(":scope > summary").click();
  const toolRow = toolGroup.locator(".conversation-tool-row").first();
  await expect(toolRow).toContainText("Read file");
  await expect(toolRow.locator("pre")).toHaveCount(0);
  await toolRow.locator(".conversation-tool-row__header").click();
  await expect(toolRow.locator(".conversation-tool-row__output")).toContainText("ok");
  await expect(toolRow.locator(".conversation-raw pre")).toHaveCount(0);
  await toolRow.locator(".conversation-raw").first().locator("summary").click();
  await expect(toolRow.locator(".conversation-raw pre").first()).toContainText("README.md");
  await expect(toolRow).toContainText("filesystem/read_file");
  const infoButton = page.getByRole("button", { name: "Open message info" }).first();
  await infoButton.click();
  await expect(page.getByRole("dialog", { name: "Info" })).toContainText("gpt-exact-1");
  await expect(
    page.getByRole("dialog", { name: "Info" }).getByText("final", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Preserved raw protocol records/)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Info" }).locator("pre")).toHaveCount(0);
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
  const targetRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === `/api/sessions/${sessionId}/turns` &&
      url.searchParams.has("targetTurnId")
    ) {
      targetRequests.push(url.href);
    }
  });
  await page.setViewportSize({ width: 390, height: 800 });
  await goto(`/session/${sessionId}`, { waitUntil: "hydration" });
  const toggle = page.getByRole("button", { name: "Open turn minimap" });

  await toggle.click();
  await expect(
    page.locator('#turn-minimap-panel .turn-minimap__target[tabindex="0"]'),
  ).toBeFocused();
  const recentMarker = page.getByRole("button", { name: /Turn 25:/ });
  await recentMarker.focus();
  await expect(recentMarker).toBeFocused();
  const preview = page.locator(".turn-minimap__preview");
  await expect(preview).toBeVisible();
  const recentCenter = await preview.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.getPropertyValue("--turn-preview-center")),
  );
  const marker21 = page.getByRole("button", { name: /Turn 21:/ });
  await marker21.focus();
  await expect
    .poll(() =>
      preview.evaluate((element) =>
        Number.parseFloat((element as HTMLElement).style.getPropertyValue("--turn-preview-center")),
      ),
    )
    .not.toBe(recentCenter);
  const measuredCenter = await page.locator(".turn-minimap").evaluate((nav) => {
    const marker = nav.querySelector<HTMLElement>(
      '.turn-minimap__target[data-turn-id="turn-21"] .turn-minimap__marker',
    );
    const previewElement = nav.querySelector<HTMLElement>(".turn-minimap__preview");
    if (marker === null || previewElement === null) {
      return Number.NaN;
    }
    const markerRect = marker.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const expected = markerRect.top - navRect.top + markerRect.height / 2;
    const actual = Number.parseFloat(
      previewElement.style.getPropertyValue("--turn-preview-center"),
    );
    return Math.abs(expected - actual);
  });
  expect(measuredCenter).toBeLessThanOrEqual(1);

  await marker21.press("Home");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/turn=turn-1/);
  await expect(
    page.getByLabel("Conversation timeline").getByText("Build the parser", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => targetRequests.some((url) => url.includes("targetTurnId=turn-1")))
    .toBe(true);

  await toggle.click();
  await marker21.click();
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

      removeEventListener(type: string, listener: EventListener): void {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((entry) => entry !== listener),
        );
      }
      close(): void {}
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
  await page.getByRole("link", { name: "Open Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/u);
  await expect.poll(() => page.evaluate(() => window.viewerEventListenerCount())).toBe(0);
});
