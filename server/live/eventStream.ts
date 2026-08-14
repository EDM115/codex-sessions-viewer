import type { EventStreamMessage } from "h3";

import { InvalidationBus } from "./invalidationBus.ts";

export interface InvalidationEventStream {
  push(message: EventStreamMessage): Promise<void>;
  send(): Promise<void>;
  close(): Promise<void>;
  onClosed(callback: () => void): void;
}

export function connectInvalidationStream(
  bus: InvalidationBus,
  stream: InvalidationEventStream,
): () => void {
  const unsubscribe = bus.subscribe((invalidation) => {
    void stream
      .push({
        id: invalidation.revision,
        event: invalidation.type,
        data: JSON.stringify(invalidation),
      })
      .catch(async () => {
        unsubscribe();
        await stream.close();
      });
  });
  stream.onClosed(unsubscribe);
  return unsubscribe;
}

export async function sendInvalidationStream(
  bus: InvalidationBus,
  stream: InvalidationEventStream,
): Promise<void> {
  const unsubscribe = connectInvalidationStream(bus, stream);
  try {
    await stream.send();
  } catch (error) {
    unsubscribe();
    throw error;
  }
}
