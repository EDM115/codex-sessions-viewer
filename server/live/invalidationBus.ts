import {
  viewerInvalidationSchema,
  type ViewerInvalidation,
} from "../../shared/types/repository.ts";

export type InvalidationListener = (event: ViewerInvalidation) => void;

export class InvalidationBus {
  readonly #listeners = new Set<InvalidationListener>();
  #sequence = 0;

  get listenerCount(): number {
    return this.#listeners.size;
  }

  publish(input: ViewerInvalidation): number {
    const event = viewerInvalidationSchema.parse(input);
    this.#sequence += 1;
    for (const listener of this.#listeners) {
      listener(event);
    }
    return this.#sequence;
  }

  subscribe(listener: InvalidationListener): () => void {
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }
}
