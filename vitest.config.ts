import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineVitestProject } from "@nuxt/test-utils/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^#shared\/(.*)$/u, replacement: `${resolve("shared")}/$1` },
      { find: /^~\/(.*)$/u, replacement: `${resolve("app")}/$1` },
    ],
  },
  test: {
    clearMocks: true,
    maxWorkers: 2,
    coverage: {
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
        "server/content/faviconSecurity.ts": { branches: 90 },
        "server/content/sanitizeSvg.ts": { branches: 90 },
        "server/core/paths.ts": { branches: 90 },
        "server/ingestion/jsonlStream.ts": { branches: 90 },
        "server/ingestion/stableRead.ts": { branches: 90 },
        "server/metadata/stateSnapshot.ts": { branches: 90 },
      },
    },
    mockReset: true,
    restoreMocks: true,
    projects: [
      {
        test: {
          name: "node",
          maxWorkers: 2,
          include: ["tests/unit/**/*.{test,spec}.ts", "tests/integration/**/*.{test,spec}.ts"],
          exclude: [
            "tests/unit/content-rendering/**/*",
            "tests/unit/ui/**/*",
            "tests/integration/export/pagefind.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "http",
          sequencer: { groupOrder: 2 },
          include: ["tests/http/**/*.{test,spec}.ts"],
          environment: "node",
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        resolve: {
          alias: [{ find: /^#shared\/(.*)$/u, replacement: `${resolve("shared")}/$1` }],
        },
        test: {
          name: "pagefind",
          include: ["tests/integration/export/pagefind.test.ts"],
          environment: "node",
          fileParallelism: false,
          sequencer: { groupOrder: 1 },
        },
      },
      {
        resolve: {
          alias: [{ find: /^#shared\/(.*)$/u, replacement: `${resolve("shared")}/$1` }],
        },
        test: {
          name: "performance",
          sequencer: { groupOrder: 3 },
          maxWorkers: 1,
          fileParallelism: false,
          include: ["tests/performance/**/*.{test,spec}.ts"],
          environment: "node",
        },
      },
      ...(existsSync(resolve("tests/nuxt"))
        ? [
            await defineVitestProject({
              test: {
                name: "nuxt",
                maxWorkers: 2,
                include: ["tests/nuxt/**/*.{test,spec}.ts"],
                environment: "nuxt",
                environmentOptions: {
                  nuxt: {
                    overrides: {
                      experimental: {
                        buildCache: false,
                      },
                    },
                  },
                },
              },
            }),
          ]
        : []),
    ],
  },
});
