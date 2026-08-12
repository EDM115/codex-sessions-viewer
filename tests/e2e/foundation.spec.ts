import { expect, test } from "@nuxt/test-utils/playwright";

test("serves rendered HTML", async ({ request }) => {
  const response = await request.get("/");

  expect(response.ok()).toBe(true);
  await expect(response.text()).resolves.toContain(
    "<h1>Codex Sessions Viewer</h1>",
  );
});

test("hydrates and performs client-side navigation", async ({ page, goto }) => {
  await goto("/", { waitUntil: "hydration" });
  await page.getByRole("link", { name: "About this viewer" }).click();

  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "About Codex Sessions Viewer",
  );
});
