import { fileURLToPath } from "node:url";

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@nuxt/test-utils/playwright";
import type { Page } from "@playwright/test";

test.use({
  nuxt: {
    rootDir: fileURLToPath(new URL("../..", import.meta.url)),
    dev: false,
    host: process.env["CODEX_VIEWER_TEST_URL"],
    build: true,
    nuxtConfig: {
      experimental: { buildCache: false },
    },
    env: {
      LOCALAPPDATA: fileURLToPath(new URL("../../.tmp/task10-browser/content/", import.meta.url)),
      CODEX_VIEWER_MODE: "live",
      CODEX_VIEWER_CODEX_HOME: fileURLToPath(new URL("../fixtures", import.meta.url)),
    },
  },
});

const sessionRoute = "/session/11111111-1111-4111-8111-111111111111?turn=turn-1#turn-turn-1";

async function assertResponsiveWidths(
  page: Page,
  widths: readonly number[],
  index = 0,
): Promise<void> {
  const width = widths[index];
  if (width === undefined) {
    return;
  }
  await page.setViewportSize({ width, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
  await assertResponsiveWidths(page, widths, index + 1);
}

test("renders code and tables without widening responsive conversation layouts", async ({
  context,
  page,
  goto,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.clock.setFixedTime(new Date("2026-08-15T12:00:00.000Z"));
  await page.setViewportSize({ width: 768, height: 900 });
  await goto(sessionRoute, { waitUntil: "hydration" });
  const openingAttachment = page
    .locator(".conversation-message--user")
    .first()
    .locator(".rich-media-placeholder.is-missing");
  await expect(openingAttachment).toContainText("Recorded image");
  await expect(openingAttachment).toContainText("Cached media is unavailable.");

  const code = page.locator(".rich-code-block").first();
  await expect(code.getByText("TypeScript", { exact: true })).toBeVisible();
  await expect(code.getByText("reader.ts", { exact: true })).toBeVisible();
  await expect(code.locator("code")).toContainText("const answer: number = 42");
  await code.getByRole("button", { name: "Copy code" }).click();
  await expect(code.getByRole("button", { name: "Copied: Copy code" })).toBeVisible();
  await code.getByRole("button", { name: "Wrap code" }).click();
  await expect(code).toHaveClass(/is-wrapped/u);

  const table = page.locator(".rich-table").first();
  await expect(table.getByRole("cell", { name: "gpt-exact-1" })).toBeVisible();
  await table.getByRole("button", { name: "Copy table options" }).click();
  await table.getByRole("menuitem", { name: "Copy CSV" }).click();
  await expect(table.getByRole("button", { name: "Copy table options" })).toHaveAttribute(
    "data-state",
    "success",
  );

  await assertResponsiveWidths(page, [320, 375, 414, 768]);

  await page.setViewportSize({ width: 768, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page
    .locator(".conversation-message--assistant")
    .first()
    .evaluate((element) => {
      const measure = (node: Element) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          tag: node.tagName,
          class: node.className,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          padding: style.padding,
          border: style.borderWidth,
          margin: style.margin,
          overflow: style.overflow,
        };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        fonts: document.fonts.status,
        answer: measure(element),
        openingAttachments: [
          ...element
            .closest(".conversation-turn")!
            .querySelectorAll(".conversation-message--user .rich-media-placeholder"),
        ].map(measure),
        children: [
          ...element.querySelectorAll(
            ".rich-code-block, .rich-mermaid, .rich-table, .rich-image, .conversation-message__footer, p",
          ),
        ].map(measure),
        ancestors: [
          element.parentElement!,
          element.closest(".progressive-conversation")!,
          element.closest(".progressive-workbench")!,
        ].map(measure),
      };
    });
  console.log(JSON.stringify({ rootGeometry: geometry }));
  expect(geometry.viewport.devicePixelRatio).toBe(1);
  expect(geometry.fonts).toBe("loaded");
  expect(geometry.answer.fontFamily).toContain('"Geist Variable"');
  expect(geometry.answer.width).toBe(640);
  expect(geometry.answer.height).toBe(690.875);
  expect(geometry.children.map(({ tag, width, height }) => ({ tag, width, height }))).toEqual([
    { tag: "P", width: 624, height: 18.59375 },
    { tag: "P", width: 624, height: 26.875 },
    { tag: "FIGURE", width: 624, height: 105.671875 },
    { tag: "FIGURE", width: 624, height: 124.34375 },
    { tag: "FIGURE", width: 624, height: 135.390625 },
    { tag: "P", width: 624, height: 128 },
    { tag: "FOOTER", width: 624, height: 32 },
  ]);
  expect(geometry.openingAttachments).toHaveLength(1);
  await test.info().attach("root-geometry", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });
  await test
    .info()
    .attach("root-viewport", { body: await page.screenshot(), contentType: "image/png" });
  // The full answer is taller than the 900px viewport's scrolling surface
  await page.setViewportSize({ width: 768, height: 1200 });
  const answer = page.locator(".conversation-message--assistant").first();
  await answer.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      answer.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const surface = element.closest(".progressive-conversation")!.getBoundingClientRect();
        return (
          rect.top >= surface.top &&
          rect.bottom <= surface.bottom &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          element.contains(document.elementFromPoint(rect.left + 12, rect.top + 8))
        );
      }),
    )
    .toBe(true);
  const captureGeometry = await answer.evaluate((element) => {
    const { x, y, width, height, bottom } = element.getBoundingClientRect();
    return { x, y, width, height, bottom, rasterHeight: Math.ceil(bottom) - Math.floor(y) };
  });
  expect(captureGeometry.width).toBe(640);
  expect(captureGeometry.height).toBe(geometry.answer.height);
  console.log(JSON.stringify({ rootCaptureGeometry: captureGeometry }));
  await test.info().attach("root-capture-geometry", {
    body: JSON.stringify(captureGeometry, null, 2),
    contentType: "application/json",
  });
  const originalStyle = await answer.getAttribute("style");
  const positioning = await answer.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      position: style.position,
      top: style.top,
      bottom: style.bottom,
      transform: style.transform,
      translate: style.translate,
    };
  });
  expect(positioning).toEqual({
    position: "static",
    top: "auto",
    bottom: "auto",
    transform: "none",
    translate: "none",
  });
  // Keep the accepted .75 raster phase without moving natural layout checks or replacing the golden
  const adjustment = Math.round(captureGeometry.y - 0.75) + 0.75 - captureGeometry.y;
  expect(Math.abs(adjustment)).toBeLessThanOrEqual(0.5);
  try {
    await answer.evaluate((element, offset) => {
      element.style.position = "relative";
      element.style.top = `${offset}px`;
    }, adjustment);
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    const adjusted = await answer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const surface = element.closest(".progressive-conversation")!.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        fullyVisible:
          rect.top >= surface.top &&
          rect.bottom <= surface.bottom &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          element.contains(document.elementFromPoint(rect.left + 12, rect.top + 8)),
      };
    });
    expect(adjusted.width).toBe(captureGeometry.width);
    expect(adjusted.height).toBe(captureGeometry.height);
    expect(adjusted.x).toBe(captureGeometry.x);
    expect(adjusted.fullyVisible).toBe(true);
    expect(Math.abs(adjusted.y - captureGeometry.y)).toBeLessThanOrEqual(0.5);
    expect(adjusted.y - captureGeometry.y).toBe(adjustment);
    expect(adjusted.y - Math.floor(adjusted.y)).toBe(0.75);
    const phaseReceipt = {
      natural: captureGeometry,
      requestedDelta: adjustment,
      actualDelta: adjusted.y - captureGeometry.y,
      adjusted,
    };
    console.log(JSON.stringify({ rootCapturePhase: phaseReceipt }));
    await test.info().attach("root-capture-phase", {
      body: JSON.stringify(phaseReceipt, null, 2),
      contentType: "application/json",
    });
    await expect(answer).toHaveScreenshot("rich-conversation-message.png", {
      animations: "disabled",
      caret: "hide",
    });
    const settledPosition = await answer.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
    expect(settledPosition).toEqual({
      x: adjusted.x,
      y: adjusted.y,
      width: adjusted.width,
      height: adjusted.height,
    });
  } finally {
    await answer.evaluate((element, savedStyle) => {
      if (savedStyle === null) {
        element.removeAttribute("style");
      } else {
        element.setAttribute("style", savedStyle);
      }
    }, originalStyle);
  }
  expect(await answer.getAttribute("style")).toBe(originalStyle);
});

test("renders Mermaid on Preview and exercises the shared SVG viewer", async ({
  context,
  page,
  goto,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1024, height: 900 });
  await goto(sessionRoute, { waitUntil: "hydration" });

  const mermaid = page.locator(".rich-mermaid").first();
  await expect(mermaid.getByRole("tab", { name: "Show Mermaid code" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(mermaid.locator("pre")).toContainText("Source --> Preview");
  await expect(mermaid.locator("[data-mermaid-preview] svg")).toHaveCount(0);

  await mermaid.getByRole("tab", { name: "Preview Mermaid diagram" }).click();
  await expect(mermaid.locator("[data-mermaid-preview] svg")).toBeVisible();
  await expect(mermaid.locator("[data-mermaid-preview] svg")).toContainText("Source");
  await expect(mermaid.locator("[data-mermaid-preview] svg")).toContainText("Preview");

  const opener = mermaid.getByRole("button", { name: "Open Mermaid diagram" });
  await opener.click();
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".media-viewer__stage")).toBeFocused();
  await assertResponsiveWidths(page, [320, 375, 414, 768, 1024]);
  await expect
    .poll(() =>
      viewer.evaluate((element) => getComputedStyle(element, "::backdrop").backdropFilter),
    )
    .not.toBe("none");

  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect(viewer.locator(".media-viewer__content")).toHaveAttribute(
    "style",
    /scale\(1\.25\)/u,
  );
  await viewer.getByRole("button", { name: "Reset view" }).click();
  await expect(viewer.locator(".media-viewer__content")).toHaveAttribute("style", /scale\(1\)/u);

  const svgDownload = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Download SVG" }).click();
  expect((await svgDownload).suggestedFilename()).toBe("diagram.svg");
  const pngDownload = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Download PNG" }).click();
  expect((await pngDownload).suggestedFilename()).toBe("diagram.png");
  await viewer.getByRole("button", { name: "Copy diagram as PNG" }).click();
  await expect(viewer.getByRole("button", { name: "Copied: Copy image" })).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).include(".media-viewer").analyze();
  expect(accessibility.violations).toEqual([]);
  await viewer.press("Escape");
  await expect(opener).toBeFocused();
});

test("opens cached images in the shared viewer with download and clipboard controls", async ({
  context,
  page,
  goto,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 768, height: 900 });
  await goto(sessionRoute, { waitUntil: "hydration" });

  const opener = page.getByRole("button", { name: "Open image: Generated pixel" });
  await expect(opener.locator("img")).toHaveAttribute("loading", "lazy");
  await opener.click();
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img[alt="Generated pixel"]')).toBeVisible();

  await viewer.getByRole("button", { name: "Original size" }).click();
  await expect(viewer.locator(".media-viewer__content")).toHaveClass(/is-original/u);
  await viewer.getByRole("button", { name: "Fit media" }).click();
  await expect(viewer.locator(".media-viewer__content")).toHaveClass(/is-fitted/u);
  const download = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Download image" }).click();
  expect((await download).suggestedFilename()).toBe("attachment.png");
  await viewer.getByRole("button", { name: "Copy image" }).click();
  await expect(viewer.getByRole("button", { name: "Copied: Copy image" })).toBeVisible();

  await expect(viewer).toHaveScreenshot("image-media-viewer.png", {
    animations: "disabled",
    caret: "hide",
  });
  await viewer.press("Escape");
  await expect(opener).toBeFocused();
});
