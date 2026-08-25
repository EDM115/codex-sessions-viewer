import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type StableRead = typeof import("../../../server/ingestion/stableRead.ts").stableRead;

const stableRead = vi.hoisted(() => vi.fn<StableRead>());

function stableResult(bytesRead: number): Awaited<ReturnType<StableRead>> {
  return {
    status: "stable",
    bytesRead,
    start: 0,
    endExclusive: bytesRead,
    identity: { device: 1n, inode: 1n },
    size: bytesRead,
    mtimeMs: 0,
  };
}

vi.mock("../../../server/ingestion/stableRead.ts", () => ({ stableRead }));

import {
  readRetainedStateSnapshot,
  snapshotStateDatabase,
} from "../../../server/metadata/stateSnapshot.ts";
import { createStateDatabase } from "../../integration/source-boundary/fixtures.ts";

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

  it("retains the previous valid generation after a later stable-read failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-state-race-"));
    temporaryDirectories.push(root);
    const sourceDatabase = join(root, "state_5.sqlite");
    const snapshotRoot = join(root, "snapshots");
    const writer = createStateDatabase(sourceDatabase);
    writer.close();
    const sourceBytes = await readFile(sourceDatabase);
    stableRead.mockImplementationOnce(async (_path, options) => {
      await options?.onChunk?.({ bytes: sourceBytes, offset: 0 });
      return stableResult(sourceBytes.byteLength);
    });
    const first = await snapshotStateDatabase({
      sourceDatabase,
      sourceWal: `${sourceDatabase}-wal`,
      snapshotRoot,
    });
    stableRead.mockRejectedValueOnce(new Error("copy failed"));

    const second = await snapshotStateDatabase({
      sourceDatabase,
      sourceWal: `${sourceDatabase}-wal`,
      snapshotRoot,
    });

    expect(first.status).toBe("created");
    expect(second).toMatchObject({
      status: "retained",
      generationPath: first.generationPath,
      metadata: first.metadata,
      diagnostics: [expect.objectContaining({ code: "metadata.snapshot_invalid" })],
    });
    await expect(readRetainedStateSnapshot(snapshotRoot)).resolves.toMatchObject({
      status: "retained",
      diagnostics: [],
    });
  });

  it("reports an unavailable retained manifest without hiding the diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-state-race-"));
    temporaryDirectories.push(root);

    await expect(readRetainedStateSnapshot(join(root, "snapshots"))).resolves.toMatchObject({
      status: "unavailable",
      generationPath: null,
      metadata: null,
      diagnostics: [expect.objectContaining({ code: "metadata.snapshot_invalid" })],
    });
  });

  it("rejects a source whose observation changes after a successful copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-state-race-"));
    temporaryDirectories.push(root);
    const sourceDatabase = join(root, "state_5.sqlite");
    const writer = createStateDatabase(sourceDatabase);
    writer.close();
    const sourceBytes = await readFile(sourceDatabase);
    stableRead.mockImplementationOnce(async (_path, options) => {
      await options?.onChunk?.({ bytes: sourceBytes, offset: 0 });
      await writeFile(sourceDatabase, Buffer.concat([sourceBytes, Buffer.from([0])]));
      return stableResult(sourceBytes.byteLength);
    });

    const result = await snapshotStateDatabase({
      sourceDatabase,
      sourceWal: `${sourceDatabase}-wal`,
      snapshotRoot: join(root, "snapshots"),
    });

    expect(result).toMatchObject({
      status: "unavailable",
      generationPath: null,
      diagnostics: [
        expect.objectContaining({
          code: "metadata.snapshot_invalid",
          details: { reason: "Codex state changed while snapshot bytes were copied" },
        }),
      ],
    });
  });

  it("bounds diagnostics for a non-Error stable-read rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-state-race-"));
    temporaryDirectories.push(root);
    const sourceDatabase = join(root, "state_5.sqlite");
    await writeFile(sourceDatabase, "source bytes");
    stableRead.mockRejectedValueOnce("opaque rejection");

    const result = await snapshotStateDatabase({
      sourceDatabase,
      sourceWal: `${sourceDatabase}-wal`,
      snapshotRoot: join(root, "snapshots"),
    });

    expect(result.diagnostics[0]?.details).toEqual({ reason: "Unknown snapshot error" });
    expect(JSON.stringify(result)).not.toContain("opaque rejection");
  });
});
