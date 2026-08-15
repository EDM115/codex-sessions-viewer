import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineVitestProject } from "@nuxt/test-utils/config";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: /^#shared\/(.*)$/u, replacement: `${resolve("shared")}/$1` }],
  },
  test: {
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/unit/**/*.{test,spec}.ts", "tests/integration/**/*.{test,spec}.ts"],
          exclude: ["tests/unit/ui/**/*"],
          environment: "node",
        },
      },
      {
        plugins: [vue()],
        resolve: {
          alias: [{ find: /^#shared\/(.*)$/u, replacement: `${resolve("shared")}/$1` }],
        },
        test: {
          name: "ui",
          include: ["tests/unit/ui/**/*.{test,spec}.ts"],
          environment: "happy-dom",
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
