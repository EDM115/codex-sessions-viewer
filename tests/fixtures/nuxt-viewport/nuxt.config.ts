import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..").replaceAll(
  "\\",
  "/",
);
export default defineNuxtConfig({
  compatibilityDate: "2026-08-01",
  pages: true,
  devtools: { enabled: false },
  devServer: { host: "127.0.0.1" },
  alias: { "#shared": `${workspace}/shared`, "~": `${workspace}/app` },
  components: [{ path: `${workspace}/app/components`, pathPrefix: true }],
  imports: { dirs: [`${workspace}/app/composables`] },
  css: ["tokens", "themes", "base", "components"].map(
    (name) => `${workspace}/app/assets/css/${name}.css`,
  ),
  runtimeConfig: { public: { viewerMode: "live", pagefindEnabled: false } },
});
