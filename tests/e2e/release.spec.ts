/* oxlint-disable no-await-in-loop -- Theme and responsive assertions intentionally reuse one browser page sequentially. */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@nuxt/test-utils/playwright";
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    viewerReleaseVitals: { cls: number; lcp: number };
  }
}

async function representativeContrast(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const colorBytes = (value: string): [number, number, number, number] => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context === null) {
          throw new Error("Canvas color conversion is unavailable.");
        }
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
        return [red, green, blue, alpha];
      };
      const opaqueBackground = (start: Element): [number, number, number, number] => {
        let current: Element | null = start;
        while (current !== null) {
          const background = colorBytes(getComputedStyle(current).backgroundColor);
          if (background[3] === 255) {
            return background;
          }
          current = current.parentElement;
        }
        return [255, 255, 255, 255];
      };
      const luminance = ([red, green, blue]: readonly number[]): number =>
        [red, green, blue]
          .map((channel) => {
            const normalized = (channel ?? 0) / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          })
          .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
      const foreground = luminance(colorBytes(getComputedStyle(element).color));
      const background = luminance(opaqueBackground(element));
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
}

test("all themes pass axe and representative computed WCAG contrast", async ({ page, goto }) => {
  await goto("/settings", { waitUntil: "hydration" });
  const themes = [
    ["Midnight Glass", "midnight-glass"],
    ["Quiet Precision", "quiet-precision"],
    ["Editorial Archive", "editorial-archive"],
  ] as const;

  for (const [label, value] of themes) {
    await page.getByRole("button", { name: new RegExp(label, "u") }).click();
    await expect(page.locator(".app-root")).toHaveAttribute("data-theme", value);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    for (const selector of [
      ".settings-hero__lead",
      ".settings-section__heading h2",
      ".settings-theme-choice strong",
      ".settings-toggle-row small",
    ]) {
      expect(
        await representativeContrast(page, selector),
        `${value} ${selector}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("blocks external automatic requests and exposes no session creation action", async ({
  page,
  goto,
}) => {
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy|violates the following directive/iu.test(message.text())) {
      cspViolations.push(message.text());
    }
  });
  await goto("/", { waitUntil: "hydration" });
  const localOrigin = new URL(page.url()).origin;
  const liveResponse = await page.request.get(localOrigin);
  // Expected browser policy is independent of the implementation that emits the headers.
  expect(liveResponse.headers()).toMatchObject({
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow, noarchive",
  });
  const directives = Object.fromEntries(
    liveResponse
      .headers()
      ["content-security-policy"]!.split(";")
      .map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/u);
        return [name, sources];
      }),
  );
  expect(directives).toEqual({
    "default-src": ["'self'"],
    "base-uri": ["'none'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'none'"],
    "connect-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "media-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "worker-src": ["'self'"],
  });
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== localOrigin) {
      externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.reload({ waitUntil: "networkidle" });

  expect(externalRequests).toEqual([]);
  expect(cspViolations).toEqual([]);
  await expect(page.getByRole("button", { name: /create|new session/iu })).toHaveCount(0);
  const settings = page.getByRole("link", { name: "Open Settings" });
  await expect(settings).toHaveCount(1);
  await expect(settings.locator("svg")).toHaveCount(1);
  await settings.hover();
  await expect(page.getByRole("tooltip", { name: "Settings" })).toBeVisible();
});

test("stays within responsive and local performance budgets", async ({ page, goto }) => {
  await page.addInitScript(() => {
    window.viewerReleaseVitals = { cls: 0, lcp: 0 };
    new PerformanceObserver((list) => {
      window.viewerReleaseVitals.lcp = Math.max(
        window.viewerReleaseVitals.lcp,
        ...list.getEntries().map(({ startTime }) => startTime),
      );
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!("hadRecentInput" in entry) || !entry.hadRecentInput) {
          window.viewerReleaseVitals.cls += "value" in entry ? Number(entry.value) : 0;
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await goto("/", { waitUntil: "hydration" });
  await page.waitForTimeout(250);
  const required = [320, 375, 414, 768, 1024, 1440];
  const sweep = Array.from({ length: 21 }, (_, index) => 320 + index * 80);
  for (const width of [...new Set([...required, ...sweep, 1920])].toSorted((a, b) => a - b)) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      html: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(overflow, `horizontal overflow at ${width}px`).toEqual({ body: 0, html: 0 });
  }

  await page.setViewportSize({ width: 390, height: 800 });
  const interactionDuration = await page.evaluate(async () => {
    const field = document.querySelector<HTMLInputElement>('input[type="search"]');
    if (field === null) {
      throw new Error("Search field is unavailable.");
    }
    const startedAt = performance.now();
    field.focus();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return performance.now() - startedAt;
  });
  const vitals = await page.evaluate(() => window.viewerReleaseVitals);

  expect(vitals.lcp).toBeGreaterThan(0);
  expect(vitals.lcp).toBeLessThan(2_500);
  expect(vitals.cls).toBeLessThan(0.1);
  expect(interactionDuration).toBeLessThan(200);

  const sessionId = "11111111-1111-4111-8111-111111111111";
  await goto(`/session/${sessionId}?turn=turn-21`, { waitUntil: "hydration" });
  for (const width of [320, 375, 414, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator(".conversation-timeline").evaluate((timeline) => {
      const bounds = timeline.getBoundingClientRect();
      return {
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        left: bounds.left,
        right: bounds.right,
        viewport: document.documentElement.clientWidth,
      };
    });
    expect(geometry.documentOverflow, `session overflow at ${width}px`).toBe(0);
    expect(geometry.left, `timeline left edge at ${width}px`).toBeGreaterThanOrEqual(0);
    expect(geometry.right, `timeline right edge at ${width}px`).toBeLessThanOrEqual(
      geometry.viewport + 1,
    );
  }
});
