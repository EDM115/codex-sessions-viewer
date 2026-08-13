import { afterEach, describe, expect, it, vi } from "vitest";

import { CliExportProgress } from "../../../server/export/exportProgress.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("export CLI progress", () => {
  it("renders weighted stage and item progress as readable non-TTY log lines", () => {
    const output: string[] = [];
    const progress = new CliExportProgress({
      interactive: false,
      write: (text) => output.push(text),
      heartbeatMs: 60_000,
    });

    progress.setSteps([{ weight: 1 }, { weight: 3 }]);
    progress.status("Discovering Codex sessions");
    progress.step("Discovered 4 sessions");
    progress.statusProgress("Updating session cache", 1, 4);
    progress.statusProgress("Updating session cache", 2, 4);
    progress.step("Updated 4 sessions");
    progress.finish();

    const rendered = output.join("");
    expect(rendered).toContain("[  0%] Discovering Codex sessions");
    expect(rendered).toContain("✓ Discovered 4 sessions");
    expect(rendered).toContain("[ 44%] Updating session cache (1/4)");
    expect(rendered).toContain("[ 63%] Updating session cache (2/4)");
    expect(rendered).toContain("✓ Updated 4 sessions");
    expect(rendered).not.toContain("\u001B[");
  });

  it("emits heartbeats during an otherwise silent long operation and stops them after finish", () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const progress = new CliExportProgress({
      interactive: false,
      write: (text) => output.push(text),
      heartbeatMs: 5_000,
    });

    progress.setSteps([{ weight: 1 }]);
    progress.status("Generating the Nuxt static site");
    progress.suspend();
    const beforeHeartbeat = output.length;
    vi.advanceTimersByTime(5_000);

    expect(output.length).toBeGreaterThan(beforeHeartbeat);
    expect(output.at(-1)).toContain("Generating the Nuxt static site — still working");

    progress.finish();
    const afterFinish = output.length;
    vi.advanceTimersByTime(10_000);
    expect(output).toHaveLength(afterFinish);
  });

  it("suspends in-place rendering while a child process owns the terminal", () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const progress = new CliExportProgress({
      interactive: true,
      write: (text) => output.push(text),
      heartbeatMs: 5_000,
    });

    progress.setSteps([{ weight: 1 }]);
    progress.status("Generating the Nuxt static site");
    progress.suspend();
    const afterSuspend = output.join("");
    vi.advanceTimersByTime(10_000);

    expect(output.join("")).toBe(afterSuspend);
    expect(afterSuspend).toContain("\u001B[K");

    progress.resume();
    expect(output.join("").length).toBeGreaterThan(afterSuspend.length);
    progress.finish();
  });
});
