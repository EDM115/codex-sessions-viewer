import {
  savedFaviconRevision,
  subscribeFaviconAvailability,
} from "#shared/content/faviconAvailability.ts";

export { publishFaviconAvailability } from "#shared/content/faviconAvailability.ts";

// The framework-free repository publishes signals, mounted UI tracks their latest generation
const revision = shallowRef(0);
const unsubscribe = subscribeFaviconAvailability(() => {
  revision.value += 1;
});
if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribe);
}

export function faviconRevision(origin: string): string | undefined {
  void revision.value;
  return savedFaviconRevision(origin);
}
