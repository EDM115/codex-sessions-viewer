import { fileURLToPath } from "node:url";

import type { ConfigOptions } from "@nuxt/test-utils/playwright";
import { defineConfig } from "@playwright/test";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig<ConfigOptions>({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  reporter: "list",
  workers: 1,
  use: {
    nuxt: {
      rootDir,
      ...(process.env["CODEX_VIEWER_TEST_URL"]
        ? { host: process.env["CODEX_VIEWER_TEST_URL"] }
        : {}),
      env: {
        CODEX_VIEWER_CODEX_HOME: fileURLToPath(new URL("./tests/fixtures", import.meta.url)),
      },
    },
    trace: "retain-on-failure",
  },
});
