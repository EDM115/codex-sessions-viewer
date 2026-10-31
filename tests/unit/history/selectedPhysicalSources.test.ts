import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { rolloutRefFromSource } from "#server/ingestion/rolloutIdentity.ts";
import { SelectedPhysicalSources } from "#server/ingestion/selectedPhysicalSources.ts";

import {
  ancestryBasePhysical,
  mixedAncestryFixture,
} from "../../fixtures/history/mixedAncestry.ts";

it("resumes bounded physical discovery, rejects ambiguous physical owners and closes abandoned enumeration", async () => {
  const root = await mkdtemp(join(tmpdir(), "physical-"));
  const f = await mixedAncestryFixture(join(root, "home"));
  const sources = new SelectedPhysicalSources(1);
  const selected = rolloutRefFromSource(f.leafPath, null);
  try {
    await expect(sources.resolve(selected, ancestryBasePhysical)).rejects.toThrow(
      "lineage.preparation_pending",
    );
    await expect(sources.resolve(selected, ancestryBasePhysical)).rejects.toThrow(
      "lineage.preparation_pending",
    );
    expect((await sources.resolve(selected, ancestryBasePhysical))?.sourcePath).toBe(f.basePath);
    await writeFile(f.basePath.replace("10-00-00", "11-00-00"), "unused unrelated duplicate bytes");
    const advance = () => {
      sources.beginLineage(selected);
      return sources
        .resolve(selected, ancestryBasePhysical)
        .catch((error: unknown) => (error instanceof Error ? error.message : error));
    };
    const ambiguous = [await advance(), await advance(), await advance(), await advance()];
    expect(ambiguous).toEqual([
      "lineage.preparation_pending",
      "lineage.preparation_pending",
      "lineage.preparation_pending",
      null,
    ]);
    await sources.close();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(sources.resolve(selected, ancestryBasePhysical, cancelled.signal)).rejects.toThrow(
      /abort/iu,
    );
  } finally {
    await sources.close();
    await rm(root, { recursive: true, force: true });
  }
});
