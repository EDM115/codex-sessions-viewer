import { describe, expect, it, vi } from "vitest";

import { retryTransientOutputRename } from "../../../server/export/outputFiles.ts";

describe("output file replacement", () => {
  it("retries a transient Windows EPERM rename", async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error("temporarily locked"), { code: "EPERM" }))
      .mockResolvedValueOnce();

    await retryTransientOutputRename(operation, async () => undefined);

    expect(operation).toHaveBeenCalledTimes(2);
  });
});
