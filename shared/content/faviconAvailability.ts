const revisions = new Map<string, string>();
const listeners = new Set<() => void>();
const MAX_ORIGINS = 2048;

export function savedFaviconRevision(origin: string): string | undefined {
  return revisions.get(origin);
}
export function subscribeFaviconAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishFaviconAvailability(origins: readonly string[], revision: string): void {
  let changed = false;
  for (const origin of origins) {
    if (revisions.get(origin) === revision) {
      continue;
    }
    revisions.delete(origin);
    revisions.set(origin, revision);
    if (revisions.size > MAX_ORIGINS) {
      revisions.delete(revisions.keys().next().value!);
    }
    changed = true;
  }
  if (changed) {
    for (const listener of listeners) {
      listener();
    }
  }
}
