import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const viewerMode = process.env.CODEX_VIEWER_MODE === "static" ? "static" : "live";
const configuredOutput = process.env.CODEX_VIEWER_OUTPUT?.trim();
const configuredBuildOutput = process.env.CODEX_VIEWER_BUILD_OUTPUT?.trim();
const routeManifest = process.env.CODEX_VIEWER_ROUTE_MANIFEST?.trim();
const pagefindEnabled = process.env.CODEX_VIEWER_PAGEFIND !== "0";
const buildOutput =
  configuredBuildOutput === undefined
    ? viewerMode === "live"
      ? resolve(".output-live")
      : undefined
    : resolve(configuredBuildOutput);

function staticSessionRoutes(): string[] {
  if (
    viewerMode !== "static" ||
    routeManifest === undefined ||
    !existsSync(resolve("app/pages/session/[id].vue"))
  ) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(resolve(routeManifest), "utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("routes" in parsed) ||
    !Array.isArray(parsed.routes) ||
    !parsed.routes.every((route) => typeof route === "string" && route.startsWith("/session/"))
  ) {
    throw new Error("The static session route manifest has an unsupported shape.");
  }
  return [...new Set(parsed.routes)].toSorted((left, right) => left.localeCompare(right));
}

export default defineNuxtConfig({
  compatibilityDate: "2026-08-01",
  ssr: true,
  css: [
    "~/assets/css/tokens.css",
    "~/assets/css/themes.css",
    "~/assets/css/base.css",
    "~/assets/css/components.css",
  ],
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
    ...(configuredOutput === undefined && buildOutput === undefined
      ? {}
      : {
          output: {
            ...(buildOutput === undefined ? {} : { dir: buildOutput }),
            ...(configuredOutput === undefined ? {} : { publicDir: resolve(configuredOutput) }),
          },
        }),
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
  hooks: {
    "prerender:routes"({ routes }) {
      for (const route of staticSessionRoutes()) {
        routes.add(route);
      }
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
    public: {
      pagefindEnabled,
      viewerMode,
    },
  },
  routeRules: {
    "/**": {
      headers: {
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    },
  },
});
