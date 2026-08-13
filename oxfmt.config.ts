import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "pnpm-lock.yaml",
    ".generated/",
    ".nuxt/",
    ".output/",
    "dist/",
    "coverage/",
    "node_modules/",
    "playwright-report/",
    "test-results/",
  ],
  sortImports: true,
});
