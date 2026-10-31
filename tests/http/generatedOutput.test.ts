import { matchesGlob, resolve } from "node:path";

import { setup, useTestContext } from "@nuxt/test-utils/e2e";
import { expect, it } from "vitest";

let effectiveBuildDir: string | undefined;
let effectiveExclusions: string[] = [];
await setup({
  rootDir: resolve("."),
  dev: false,
  build: true,
  server: false,
  browser: false,
  nuxtConfig: {
    experimental: { buildCache: false },
    hooks: {
      "nitro:init": (nitro) => {
        const options = nitro.options;
        if (!("buildDir" in options) || typeof options.buildDir !== "string") {
          throw new Error("Expected the initialized Nitro build directory");
        }
        if (
          !("imports" in options) ||
          typeof options.imports !== "object" ||
          options.imports === null ||
          !("exclude" in options.imports) ||
          !Array.isArray(options.imports.exclude)
        ) {
          throw new Error("Expected initialized Nitro auto-import exclusions");
        }
        effectiveBuildDir = options.buildDir;
        effectiveExclusions = options.imports.exclude.map(String);
        console.log(
          JSON.stringify({
            generatedOutputAudit: true,
            buildDir: effectiveBuildDir,
            exclude: effectiveExclusions,
          }),
        );
      },
    },
  },
  setupTimeout: 240000,
});

it("excludes only the current generated SSR subtree and preserves source/default/disabled auto-import behavior", async () => {
  const nuxt = useTestContext().nuxt!;
  const configure = nuxt.options.hooks["nitro:config"];
  if (typeof configure !== "function") {
    throw new Error("Expected the actual loaded Nitro configuration hook");
  }
  const excluded = /[\\/]node_modules[\\]/u;
  const configured = {
    buildDir: nuxt.options.buildDir,
    imports: { exclude: [excluded], dirs: ["source/utils"], autoImport: true },
  };
  await configure(configured);
  const pattern = `${resolve(nuxt.options.buildDir, "dist", "server").replaceAll("\\", "/")}/**`;
  expect(effectiveBuildDir).toBe(nuxt.options.buildDir);
  expect(effectiveExclusions).toContain(pattern);
  expect(configured.imports.exclude).toEqual([excluded, pattern]);
  expect(configured.imports.dirs).toEqual(["source/utils"]);
  expect(configured.imports.autoImport).toBe(true);
  expect(
    matchesGlob(
      resolve(nuxt.options.buildDir, "dist/server/_nuxt/settings.js").replaceAll("\\", "/"),
      pattern,
    ),
  ).toBe(true);
  expect(
    matchesGlob(
      resolve(nuxt.options.buildDir, "dist/client/source.js").replaceAll("\\", "/"),
      pattern,
    ),
  ).toBe(false);
  expect(matchesGlob(resolve("server/api/events.get.ts").replaceAll("\\", "/"), pattern)).toBe(
    false,
  );
  expect(
    matchesGlob(resolve("shared/types/staticPayloads.ts").replaceAll("\\", "/"), pattern),
  ).toBe(false);
  const defaults = {
    buildDir: nuxt.options.buildDir,
    imports: { exclude: [] as (string | RegExp)[] },
  };
  await configure(defaults);
  expect(defaults.imports.exclude).toEqual([pattern]);
  const disabled = { imports: false as const };
  await configure(disabled);
  expect(disabled).toEqual({ imports: false });
  const unspecified = {};
  await configure(unspecified);
  expect(unspecified).toEqual(expect.not.objectContaining({ imports: expect.anything() }));
});
