import { fileURLToPath } from "node:url";

import type { ConfigOptions } from "@nuxt/test-utils/playwright";
import { defineConfig } from "@playwright/test";

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
