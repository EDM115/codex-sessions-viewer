import { expect, it, vi } from "vitest";

import type { SessionMetaPrefixObservation } from "#server/ingestion/sessionMetaPrefix.ts";
import { SelectedHistoryObserver } from "#server/live/selectedHistoryObserver.ts";

it("probes only active exact families and stops further probes/publication when a pending owner is released", async () => {
  vi.useFakeTimers();
  const selected = "C:/private/sessions/current.jsonl";
  const parent = "C:/private/sessions/base.jsonl.zst";
  let paths = [selected];
  const observation: SessionMetaPrefixObservation = {
    device: 1n,
    inode: 1n,
    size: 1n,
    mtimeNs: 1n,
    ctimeNs: 1n,
    regular: true,
    symbolicLink: false,
  };
  let finish: ((value: SessionMetaPrefixObservation) => void) | undefined;
  let gate = false;
  const probe = vi.fn<(path: string) => Promise<SessionMetaPrefixObservation>>(async (_path) =>
    gate
      ? new Promise<SessionMetaPrefixObservation>((resolve) => {
          finish = resolve;
        })
      : observation,
  );
  const changed = vi.fn<(id: string) => void>();
  const observer = new SelectedHistoryObserver(() => paths, changed, probe);
  let release = () => {};
  try {
    await vi.advanceTimersByTimeAsync(2000);
    expect(probe).not.toHaveBeenCalled();
    release = observer.acquire("selected");
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.mock.calls.map(([path]) => path)).toEqual([selected, `${selected}.zst`]);
    paths = [selected, parent];
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      probe.mock.calls
        .slice(2)
        .map(([path]) => path)
        .toSorted(),
    ).toEqual([parent.slice(0, -4), parent, selected, `${selected}.zst`].toSorted());
    gate = true;
    await vi.advanceTimersByTimeAsync(1000);
    const count = probe.mock.calls.length;
    const notifications = changed.mock.calls.length;
    release();
    finish?.(observation);
    await observer.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(count);
    expect(changed).toHaveBeenCalledTimes(notifications);
  } finally {
    release();
    await observer.close();
    vi.useRealTimers();
  }
});
