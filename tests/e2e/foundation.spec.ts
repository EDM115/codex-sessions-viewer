import { expect, test } from "@nuxt/test-utils/playwright";

test("serves rendered HTML", async ({ request }) => {
  const response = await request.get("/");

  expect(response.ok()).toBe(true);
  await expect(response.text()).resolves.toContain(
    "Find the exact conversation, then return to the exact turn.",
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
