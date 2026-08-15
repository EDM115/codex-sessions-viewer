import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const stableRead = vi.hoisted(() => vi.fn());

vi.mock("../../../server/ingestion/stableRead.ts", () => ({ stableRead }));

import { snapshotStateDatabase } from "../../../server/metadata/stateSnapshot.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  stableRead.mockReset();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("state snapshot source races", () => {
  it("rejects a source that changes while its bytes are copied", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-state-race-"));
    temporaryDirectories.push(root);
    const sourceDatabase = join(root, "state_5.sqlite");
    await writeFile(sourceDatabase, "source bytes");
    stableRead.mockResolvedValue({ status: "changed", retry: true, bytesRead: 0 });

    const result = await snapshotStateDatabase({
      sourceDatabase,
      sourceWal: `${sourceDatabase}-wal`,
      snapshotRoot: join(root, "snapshots"),
    });

    expect(result).toMatchObject({
      status: "unavailable",
      generationPath: null,
      diagnostics: [expect.objectContaining({ code: "metadata.snapshot_invalid" })],
    });
  });
});
