import withNuxt from "./.nuxt/eslint.config.mjs";

export default withNuxt({
  ignores: [
    ".generated/**",
    ".nuxt/**",
    ".output/**",
    "dist/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ],
});
