import { InvalidationBus } from "./invalidationBus.ts";

export interface InvalidationEventStream<Response = void> {
  push(message: { id: string; event: string; data: string }): Promise<void>;
  send(): Promise<Response>;
  close(): Promise<void>;
  onClosed(callback: () => void): void;
}

export function connectInvalidationStream<Response>(
  bus: InvalidationBus,
  stream: InvalidationEventStream<Response>,
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

export async function sendInvalidationStream<Response>(
  bus: InvalidationBus,
  stream: InvalidationEventStream<Response>,
): Promise<Response> {
  const unsubscribe = connectInvalidationStream(bus, stream);
  try {
    return await stream.send();
  } catch (error) {
    unsubscribe();
    throw error;
  }
}
