import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..").replaceAll(
  "\\",
  "/",
);
const serverFile = (path: string) => `${workspace}/server/${path}`;
export default defineNuxtConfig({
  compatibilityDate: "2026-08-01",
  devtools: { enabled: false },
  devServer: { host: "127.0.0.1" },
  alias: {
    "#shared": `${workspace}/shared`,
    "#server": `${workspace}/server`,
    "~": `${workspace}/app`,
  },
  components: [{ path: `${workspace}/app/components`, pathPrefix: true }],
  imports: { dirs: [`${workspace}/app/composables`] },
  nitro: {
    alias: { "#shared": `${workspace}/shared`, "#server": `${workspace}/server` },
    esbuild: { options: { target: "node26" } },
    handlers: [
      {
        route: "/api/sessions/:id/approvals",
        method: "get",
        handler: serverFile("api/sessions/[id]/approvals.get.ts"),
      },
      { middleware: true, handler: serverFile("middleware/loopback.ts") },
      { route: "/api/sessions", method: "get", handler: serverFile("api/sessions/index.get.ts") },
      { route: "/api/projects", method: "get", handler: serverFile("api/projects.get.ts") },
      {
        route: "/api/sessions/prepare",
        method: "post",
        handler: serverFile("api/sessions/prepare.post.ts"),
      },
      {
        route: "/api/sessions/:id",
        method: "get",
        handler: serverFile("api/sessions/[id]/index.get.ts"),
      },
      {
        route: "/api/sessions/:id/turns",
        method: "get",
        handler: serverFile("api/sessions/[id]/turns.get.ts"),
      },
      {
        route: "/api/sessions/:id/items",
        method: "get",
        handler: serverFile("api/sessions/[id]/items.get.ts"),
      },
      {
        route: "/api/sessions/:id/navigator",
        method: "get",
        handler: serverFile("api/sessions/[id]/navigator.get.ts"),
      },
      {
        route: "/api/history/presentation",
        method: "post",
        handler: serverFile("api/history/presentation.post.ts"),
      },
      { route: "/api/events", method: "get", handler: serverFile("api/events.get.ts") },
      { route: "/api/search", method: "get", handler: serverFile("api/search.get.ts") },
    ],
  },
  runtimeConfig: { viewerMode: "live", public: { viewerMode: "live", pagefindEnabled: false } },
});
