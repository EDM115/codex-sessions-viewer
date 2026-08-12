import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("project foundation", () => {
  it("pins the required package manager and runtime", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      packageManager: string;
      engines: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(packageJson.packageManager).toBe("pnpm@11.21.0");
    expect(packageJson.engines).toMatchObject({
      node: ">=26.7.0 <27",
      pnpm: ">=11.21.0 <12",
    });
    expect(packageJson.devDependencies.typescript).toMatch(/^\^6\./);
    expect(packageJson.scripts.doctor).toBe("nuxt info");
    expect(packageJson.scripts.offline).toBe("jiti scripts/offline.ts");
    expect(packageJson.scripts).not.toHaveProperty("preview");
  });
});
