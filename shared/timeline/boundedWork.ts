/** A cancelled subscriber never frees a running slot before the actual work settles */
export function createBoundedWorkQueue(limit: number, capacity = 32) {
  let active = 0;
  const queued: Array<() => void> = [];
  function run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (active >= limit && queued.length >= capacity) {
        reject(new Error("Presentation work queue is full"));
        return;
      }
      const abort = () => {
        const index = queued.indexOf(start);
        if (index >= 0) {
          queued.splice(index, 1);
        }
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const start = () => {
        if (signal?.aborted) {
          return;
        }
        active++;
        void operation()
          .then(resolve, reject)
          .finally(() => {
            active--;
            signal?.removeEventListener("abort", abort);
            queued.shift()?.();
          });
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (active < limit) {
        start();
      } else {
        queued.push(start);
      }
    });
  }
  return {
    run,
    get active() {
      return active;
    },
    get pending() {
      return queued.length;
    },
  };
}

// Mermaid's global configuration and rendering form one indivisible job
export const diagramWorkQueue = createBoundedWorkQueue(1);
