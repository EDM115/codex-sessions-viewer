import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConfigOptions } from "@nuxt/test-utils/playwright";
import { defineConfig } from "@playwright/test";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const stateRoot = process.env["CODEX_VIEWER_E2E_STATE_ROOT"] ?? mkdtempSync(join(tmpdir(), "ve-"));
process.env["CODEX_VIEWER_E2E_STATE_ROOT"] = stateRoot;
const fixtureHome = join(stateRoot, "h");
if (!process.env["CODEX_VIEWER_E2E_FIXTURES_READY"]) {
  mkdirSync(fixtureHome, { recursive: true });
  for (const folder of ["sessions", "archived_sessions"]) {
    cpSync(join(rootDir, "tests/fixtures", folder), join(fixtureHome, folder), { recursive: true });
  }
  writeFileSync(
    join(fixtureHome, "session_index.jsonl"),
    [
      {
        id: "11111111-1111-4111-8111-111111111111",
        thread_name: "Parser metadata title",
        updated_at: "2026-01-01T12:00:00Z",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        thread_name: "Archived metadata title",
        updated_at: "2026-01-01T12:00:00Z",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  writeFileSync(
    join(stateRoot, "isolation.json"),
    JSON.stringify(
      {
        fixtureHome,
        localAppData: join(stateRoot, "l"),
        xdgConfigHome: join(stateRoot, "c"),
        xdgCacheHome: join(stateRoot, "k"),
      },
      null,
      2,
    ),
  );
  process.env["CODEX_VIEWER_E2E_FIXTURES_READY"] = "1";
  console.log(`Playwright private viewer roots: ${join(stateRoot, "isolation.json")}`);
}

export default defineConfig<ConfigOptions>({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  reporter: "list",
  workers: 1,
  use: {
    nuxt: {
      rootDir,
      nuxtConfig: {
        experimental: { buildCache: false },
        hooks: {
          "pages:extend": (pages) => {
            pages.push({
              name: "fixture-legacy",
              path: "/__fixture/legacy/:id",
              file: join(rootDir, "tests/fixtures/ui/LegacySessionPage.vue"),
            });
          },
        },
      },
      ...(process.env["CODEX_VIEWER_TEST_URL"]
        ? { host: process.env["CODEX_VIEWER_TEST_URL"] }
        : {}),
      env: {
        CODEX_VIEWER_CODEX_HOME: fixtureHome,
        LOCALAPPDATA: join(stateRoot, "l"),
        XDG_CONFIG_HOME: join(stateRoot, "c"),
        XDG_CACHE_HOME: join(stateRoot, "k"),
      },
    },
    trace: "retain-on-failure",
  },
});
