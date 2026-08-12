import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import type { ConfigOptions } from "@nuxt/test-utils/playwright";

export default defineConfig<ConfigOptions>({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: true,
  reporter: "list",
  use: {
    nuxt: {
      rootDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    trace: "retain-on-failure",
  },
});
