import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import {
  collectDoctorReport,
  formatDoctorOfflineOutput,
  inspectOfflineOutput,
} from "#server/export/doctorReport.ts";
import { verifyGeneratedOutput } from "#server/export/verifyOutput.ts";

import { driftOutputDiagnosticCount, writeValidOutputFixture } from "../../fixtures/output.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-doctor-output-"));
  temporaryDirectories.push(root);
  return root;
}

describe("doctor offline-output inspection", () => {
  it("serializes unavailable saved aggregate evidence without turning it into a measured zero or exposing payload content", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "home");
    const cacheDir = join(root, "cache");
    await mkdir(codexHome);
    await mkdir(cacheDir);
    const paths = {
      cacheDir,
      cacheDatabase: join(cacheDir, "viewer.sqlite"),
      configDir: join(root, "config"),
      configFile: join(root, "config/config.json"),
      generatedDir: join(root, "generated"),
    };
    const database = openCacheDatabase(paths.cacheDatabase);
    database.exec(
      "CREATE TABLE catalog_sidebar (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)",
    );
    database
      .prepare("INSERT INTO catalog_sidebar VALUES (1, ?)")
      .run('{"prompt":"private-doctor-payload",broken}');
    database.close();
    const serialized = JSON.stringify(await collectDoctorReport({ cwd: root, codexHome, paths }));
    expect(JSON.parse(serialized)).toMatchObject({
      cache: {
        status: "available",
        evidence: {
          unresolvedProjectMappings: null,
          sections: {
            projectMappings: { availability: "invalid", diagnostics: ["payload-invalid"] },
          },
        },
      },
    });
    expect(serialized).not.toContain("private-doctor-payload");
  });

  it("distinguishes missing and incomplete output without claiming integrity", async () => {
    const parent = await temporaryRoot();
    await expect(inspectOfflineOutput(join(parent, "missing"))).resolves.toEqual({
      structuralStatus: "missing",
      integrityStatus: "not-checked",
      sessionCount: 0,
      missingFiles: [],
      searchIndex: "unknown",
    });

    const incomplete = join(parent, "incomplete");
    await mkdir(incomplete);
    await expect(inspectOfflineOutput(incomplete)).resolves.toMatchObject({
      structuralStatus: "incomplete",
      integrityStatus: "not-checked",
      sessionCount: 0,
      searchIndex: "unknown",
      missingFiles: expect.arrayContaining([
        "index.html",
        "payloads/export.json",
        "payloads/sessions/index.json",
      ]),
    });
  });

  it("reports structurally present disabled and Pagefind outputs as not checked", async () => {
    const disabled = await temporaryRoot();
    await writeValidOutputFixture(disabled);
    await expect(inspectOfflineOutput(disabled)).resolves.toEqual({
      structuralStatus: "present",
      integrityStatus: "not-checked",
      sessionCount: 1,
      missingFiles: [],
      searchIndex: "disabled",
    });

    const pagefind = await temporaryRoot();
    await writeValidOutputFixture(pagefind);
    await writeFile(join(pagefind, "payloads", "export.json"), '{"version":1,"pagefind":true}\n');
    await mkdir(join(pagefind, "pagefind"));
    await Promise.all([
      writeFile(join(pagefind, "pagefind", "pagefind.js"), "export const version = 1;"),
      writeFile(join(pagefind, "pagefind", "wasm.en.pagefind"), Buffer.from([0, 97, 115, 109])),
    ]);
    await expect(inspectOfflineOutput(pagefind)).resolves.toMatchObject({
      structuralStatus: "present",
      integrityStatus: "not-checked",
      searchIndex: "pagefind",
    });
  });

  it("keeps structural presence separate from a verifier-rejected integrity mismatch", async () => {
    const root = await temporaryRoot();
    await writeValidOutputFixture(root);
    await driftOutputDiagnosticCount(root);

    const report = await inspectOfflineOutput(root);
    expect(report).toMatchObject({
      structuralStatus: "present",
      integrityStatus: "not-checked",
      sessionCount: 1,
      missingFiles: [],
    });
    expect(formatDoctorOfflineOutput(report)).toEqual([
      "Offline output: structurally present (1 session, search disabled).",
      "Integrity: not checked; run pnpm verify:output for publication verification.",
    ]);
    await expect(verifyGeneratedOutput(root)).rejects.toThrow(
      "Session diagnostics do not match the indexed diagnostic count",
    );
  });
});
