import type { BigIntStats } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  open: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", () => filesystem);

import { readStableBytes, stableRead } from "../../../server/ingestion/stableRead.ts";

function observation(
  options: {
    device?: bigint;
    inode?: bigint;
    size?: bigint;
    mtimeNs?: bigint;
    ctimeNs?: bigint;
  } = {},
): BigIntStats {
  return {
    dev: options.device ?? 1n,
    ino: options.inode ?? 2n,
    size: options.size ?? 6n,
    mtimeNs: options.mtimeNs ?? 3n,
    ctimeNs: options.ctimeNs ?? 4n,
  } as BigIntStats;
}

function handle(options: { observations: BigIntStats[]; reads?: Array<{ bytesRead: number }> }) {
  return {
    stat: vi.fn(async () => options.observations.shift()!),
    read: vi.fn(async () => options.reads?.shift() ?? { bytesRead: 0 }),
    close: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  filesystem.open.mockReset();
  filesystem.stat.mockReset();
});

describe("stable-read race outcomes", () => {
  it("detects replacement between the path observation and handle acquisition", async () => {
    filesystem.stat.mockResolvedValueOnce(observation());
    filesystem.open.mockResolvedValueOnce(
      handle({ observations: [observation({ device: 9n, inode: 10n })] }),
    );

    await expect(stableRead("rollout.jsonl")).resolves.toMatchObject({
      status: "full-reparse",
      reason: "replaced",
      bytesRead: 0,
    });
  });

  it("rejects a source size that cannot be addressed safely", async () => {
    const huge = observation({ size: BigInt(Number.MAX_SAFE_INTEGER) + 1n });
    filesystem.stat.mockResolvedValueOnce(huge);
    filesystem.open.mockResolvedValueOnce(handle({ observations: [huge] }));

    await expect(stableRead("rollout.jsonl")).rejects.toThrow("too large to address safely");
  });

  it("treats a short persisted-prefix read and a zero-length source read as truncation", async () => {
    const firstHandle = handle({ observations: [observation()], reads: [{ bytesRead: 2 }] });
    filesystem.stat.mockResolvedValueOnce(observation());
    filesystem.open.mockResolvedValueOnce(firstHandle);
    await expect(
      stableRead("rollout.jsonl", {
        expectedPrefix: { offset: 0, bytes: Buffer.from("abc") },
      }),
    ).resolves.toMatchObject({ status: "full-reparse", reason: "truncated" });

    const secondHandle = handle({ observations: [observation()], reads: [{ bytesRead: 0 }] });
    filesystem.stat.mockResolvedValueOnce(observation());
    filesystem.open.mockResolvedValueOnce(secondHandle);
    await expect(stableRead("rollout.jsonl", { chunkSize: 3 })).resolves.toMatchObject({
      status: "full-reparse",
      reason: "truncated",
    });
  });

  it("detects removal or replacement after all bytes were consumed", async () => {
    const removedHandle = handle({
      observations: [observation(), observation()],
      reads: [{ bytesRead: 6 }],
    });
    filesystem.stat.mockResolvedValueOnce(observation()).mockRejectedValueOnce(new Error("gone"));
    filesystem.open.mockResolvedValueOnce(removedHandle);
    await expect(stableRead("rollout.jsonl")).resolves.toMatchObject({
      status: "full-reparse",
      reason: "replaced",
      bytesRead: 6,
    });

    const replacedHandle = handle({
      observations: [observation(), observation()],
      reads: [{ bytesRead: 6 }],
    });
    filesystem.stat
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(observation({ device: 8n, inode: 9n }));
    filesystem.open.mockResolvedValueOnce(replacedHandle);
    await expect(stableRead("rollout.jsonl")).resolves.toMatchObject({
      status: "full-reparse",
      reason: "replaced",
      bytesRead: 6,
    });
  });

  it("does not expose bytes accumulated by a non-stable read", async () => {
    const opened = {
      stat: vi.fn<() => Promise<BigIntStats>>(async () => observation()),
      read: vi.fn<(buffer: Buffer) => Promise<{ bytesRead: number }>>(async (buffer) => {
        buffer.set(Buffer.from("secret"));
        return { bytesRead: 6 };
      }),
      close: vi.fn<() => Promise<void>>(async () => undefined),
    };
    filesystem.stat
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(observation({ device: 8n, inode: 9n }));
    filesystem.open.mockResolvedValueOnce(opened);

    await expect(readStableBytes("rollout.jsonl")).resolves.toMatchObject({
      read: { status: "full-reparse", reason: "replaced", bytesRead: 6 },
      bytes: Buffer.alloc(0),
    });
    expect(opened.read).toHaveBeenCalledOnce();
    expect(opened.close).toHaveBeenCalledOnce();
  });
});
