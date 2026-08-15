import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@nuxt/test-utils/playwright";
import type { Page } from "@playwright/test";

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
  await page.setViewportSize({ width: 768, height: 900 });
  await goto(sessionRoute, { waitUntil: "hydration" });

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
  await expect(page.locator(".conversation-message--assistant").first()).toHaveScreenshot(
    "rich-conversation-message.png",
    { animations: "disabled", caret: "hide" },
  );
});

test("loads Mermaid only on Preview and exercises the shared SVG viewer", async ({
  context,
  page,
  goto,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const scripts: string[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") {
      scripts.push(response.url());
    }
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await goto(sessionRoute, { waitUntil: "hydration" });

  const mermaid = page.locator(".rich-mermaid").first();
  await expect(mermaid.getByRole("tab", { name: "Show Mermaid code" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(mermaid.locator("pre")).toContainText("Source --> Preview");
  const scriptCountBeforePreview = scripts.length;

  await mermaid.getByRole("tab", { name: "Preview Mermaid diagram" }).click();
  await expect(mermaid.locator("[data-mermaid-preview] svg")).toBeVisible();
  expect(scripts.length).toBeGreaterThan(scriptCountBeforePreview);

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
