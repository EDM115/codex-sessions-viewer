import { expect, test } from "@nuxt/test-utils/playwright";

import { historyPageQuerySchema } from "#shared/types/repository.ts";

test("keeps the source-qualified reading position when delayed navigation appears beside pending history", async ({
  page,
  goto,
}) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let releaseNavigator!: () => void;
  let releaseEarlier!: () => void;
  let navigatorRequested = false;
  let earlierRequested = false;
  const navigatorGate = new Promise<void>((resolve) => {
    releaseNavigator = resolve;
  });
  const earlierGate = new Promise<void>((resolve) => {
    releaseEarlier = resolve;
  });
  await page.route(`**/api/sessions/${sessionId}/navigator?**`, async (route) => {
    navigatorRequested = true;
    await navigatorGate;
    await route.continue();
  });
  await page.route(`**/api/sessions/${sessionId}/turns?**`, async (route) => {
    const query = historyPageQuerySchema.parse(
      JSON.parse(new URL(route.request().url()).searchParams.get("history") ?? "{}"),
    );
    if (query.anchor.kind === "before") {
      earlierRequested = true;
      await earlierGate;
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await goto(`/session/${sessionId}?turn=turn-21`, { waitUntil: "hydration" });
  const surface = page.getByLabel("Conversation timeline");
  const target = surface.locator('[data-history-turn="turn-21"]');
  await expect(target).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect.poll(() => navigatorRequested).toBe(true);
  await expect(page.getByRole("navigation", { name: "Loaded turn navigation" })).toHaveCount(0);
  const sourceIdentity = await target.getAttribute("data-anchor-source");
  expect(sourceIdentity).toBeTruthy();
  await surface
    .getByRole("button", { name: "Load older turns", exact: true })
    .evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect.poll(() => earlierRequested).toBe(true);
  await expect(page.locator(".history-status")).toContainText("Loading history…");
  // oxlint-disable no-await-in-loop -- Each responsive assertion observes the same pending request at one viewport width
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await page.locator(".history-actions").evaluate((element) => {
      const action = element.getBoundingClientRect();
      const timeline = document.querySelector(".progressive-conversation")!.getBoundingClientRect();
      const latest = element.querySelector(".history-latest")!.getBoundingClientRect();
      const status = element.querySelector(".history-status")!;
      return {
        actionTop: action.top,
        timelineBottom: timeline.bottom,
        latestRight: latest.right,
        viewportWidth: window.innerWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        title: status.getAttribute("title"),
        statusText: status.textContent,
      };
    });
    expect(bounds.actionTop).toBeGreaterThanOrEqual(bounds.timelineBottom);
    expect(bounds.latestRight).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.overflow).toBe(false);
    expect(bounds.title).toContain("Loading history…");
    expect(bounds.statusText).toContain("Loading history…");
  }
  // oxlint-enable no-await-in-loop
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(target).toBeVisible();
  await surface.evaluate((element) => {
    element.scrollTop += 96;
  });
  const before = await target.boundingBox();
  const surfaceBeforeNavigation = await surface.boundingBox();
  if (before === null || sourceIdentity === null) {
    throw new Error("The current source-qualified reading anchor must remain mounted");
  }
  releaseNavigator();
  const navigator = page.getByRole("navigation", { name: "Loaded turn navigation" });
  await expect(navigator).toBeVisible();
  expect((await surface.boundingBox())?.y).toBe(surfaceBeforeNavigation?.y);
  await expect(target).toHaveAttribute("data-anchor-source", sourceIdentity);
  await expect
    .poll(async () => Math.abs(((await target.boundingBox())?.y ?? Infinity) - before.y))
    .toBeLessThanOrEqual(3);
  releaseEarlier();
  await expect(surface).toHaveAttribute("data-retained-turns", "25");
  await expect
    .poll(async () => Math.abs(((await target.boundingBox())?.y ?? Infinity) - before.y))
    .toBeLessThanOrEqual(3);
  // oxlint-disable no-await-in-loop -- Verify the same navigation controls and keyboard focus at each responsive width
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const controls = navigator.getByRole("button");
    const controlCount = await controls.count();
    await controls.first().focus();
    for (let index = 1; index < controlCount; index++) {
      await page.keyboard.press("Tab");
    }
    const lastControl = controls.last();
    await expect(lastControl).toBeFocused();
    const bounds = await navigator.evaluate((element) => {
      const navigation = element.getBoundingClientRect();
      const controlRects = [...element.querySelectorAll("button")].map((button) =>
        button.getBoundingClientRect(),
      );
      const focused = document.activeElement!.getBoundingClientRect();
      return {
        top: navigation.top,
        bottom: navigation.bottom,
        left: navigation.left,
        right: navigation.right,
        controls: controlRects.map((control) => ({ top: control.top, bottom: control.bottom })),
        focusedLeft: focused.left,
        focusedRight: focused.right,
      };
    });
    expect(bounds.controls.length).toBeGreaterThan(0);
    expect(bounds.controls.every((control) => control.top >= bounds.top)).toBe(true);
    expect(bounds.controls.every((control) => control.bottom <= bounds.bottom)).toBe(true);
    expect(bounds.focusedLeft).toBeGreaterThanOrEqual(bounds.left);
    expect(bounds.focusedRight).toBeLessThanOrEqual(bounds.right);
  }
  // oxlint-enable no-await-in-loop
});
