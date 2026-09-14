import { shallowReactive } from "vue";

// A bounded per-origin signal survives late mounts without creating retry timers.
const revisions = shallowReactive(new Map<string, string>());
const MAX_ORIGINS = 2048;

export function faviconRevision(origin: string): string | undefined {
  return revisions.get(origin);
}

export function publishFaviconAvailability(origins: readonly string[], revision: string): void {
  for (const origin of origins) {
    if (revisions.get(origin) === revision) {
      continue;
    }
    revisions.delete(origin);
    revisions.set(origin, revision);
    if (revisions.size > MAX_ORIGINS) {
      revisions.delete(revisions.keys().next().value!);
    }
  }
}
