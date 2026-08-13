const viewerMode = process.env.CODEX_VIEWER_MODE === "static" ? "static" : "live";

export default defineNuxtConfig({
  compatibilityDate: "2026-08-01",
  ssr: true,
  devtools: {
    enabled: false,
  },
  devServer: {
    host: "127.0.0.1",
  },
  modules: [],
  future: { typescriptBundlerResolution: true },
  experimental: {
    asyncContext: true,
    buildCache: true,
    clientFallback: true,
    clientNodeCompat: true,
    crossOriginPrefetch: true,
    defaults: {
      nuxtLink: {
        prefetch: true,
        prefetchOn: {
          interaction: true,
          visibility: false,
        },
      },
    },
    entryImportMap: true,
    extractAsyncDataHandlers: true,
    inlineRouteRules: true,
    normalizeComponentNames: true,
    normalizePageNames: true,
    parseErrorData: true,
    prefetchPreloadTags: true,
    sharedPrerenderData: true,
    typedPages: true,
    typescriptPlugin: true,
    viewTransition: true,
    viteEnvironmentApi: true,
    watcher: "builder",
  },
  typescript: {
    tsConfig: {
      compilerOptions: {
        allowArbitraryExtensions: true,
        disableSizeLimit: true,
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
        incremental: true,
        isolatedDeclarations: false,
        noErrorTruncation: true,
        preserveWatchOutput: true,
        removeComments: true,
      },
    },
    typeCheck: false,
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
  sourcemap: {
    client: false,
    server: false,
  },
  nitro: {
    compressPublicAssets: {
      brotli: true,
      gzip: true,
    },
    minify: true,
    prerender: {
      crawlLinks: viewerMode === "static",
      failOnError: true,
      ignore: ["/.netlify"],
    },
  },
  vite: {
    build: {
      minify: "oxc",
      rolldownOptions: {
        experimental: {
          lazyBarrel: true,
          nativeMagicString: true,
          resolveNewUrlToAsset: true,
        },
        output: {
          comments: false,
          minify: true,
        },
      },
    },
    clearScreen: false,
    optimizeDeps: {
      include: [],
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
