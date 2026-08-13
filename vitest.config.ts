import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineVitestProject } from "@nuxt/test-utils/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/unit/**/*.{test,spec}.ts", "tests/integration/**/*.{test,spec}.ts"],
          environment: "node",
        },
      },
      ...(existsSync(resolve("tests/nuxt"))
        ? [
            await defineVitestProject({
              test: {
                name: "nuxt",
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
