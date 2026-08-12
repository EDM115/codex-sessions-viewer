const viewerMode =
  process.env.CODEX_VIEWER_MODE === "static" ? "static" : "live";

export default defineNuxtConfig({
  compatibilityDate: "2026-08-12",
  ssr: true,
  devtools: {
    enabled: false,
  },
  devServer: {
    host: "127.0.0.1",
  },
  modules: ["@nuxt/eslint"],
  eslint: {
    config: {
      autoInit: false,
      standalone: true,
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
    tsConfig: {
      compilerOptions: {
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
      },
    },
  },
  app: {
    head: {
      title: "Codex Sessions Viewer",
      htmlAttrs: {
        lang: "en",
      },
      meta: [
        {
          name: "robots",
          content: "noindex, nofollow, noarchive",
        },
      ],
    },
  },
  nitro: {
    prerender: {
      crawlLinks: viewerMode === "static",
    },
  },
  runtimeConfig: {
    viewerMode,
  },
  routeRules: {
    "/**": {
      headers: {
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    },
  },
});
