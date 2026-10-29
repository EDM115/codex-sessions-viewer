import type { H3Event } from "h3";

/** Nuxt 4's Node response close signals disconnect, request close also occurs after normal GET input */
export function historyRequestSignal(event: H3Event): AbortSignal {
  const node = event.node;
  const controller = new AbortController();
  const cleanup = () => {
    node.req.off("aborted", aborted);
    node.res.off("close", closed);
    node.res.off("finish", cleanup);
  };
  const aborted = () => {
    controller.abort(new DOMException("Client disconnected", "AbortError"));
    cleanup();
  };
  const closed = () => {
    if (!node.res.writableEnded) {
      aborted();
    } else {
      cleanup();
    }
  };
  node.req.once("aborted", aborted);
  node.res.once("close", closed);
  node.res.once("finish", cleanup);
  if (node.req.aborted || (node.res.destroyed && !node.res.writableEnded)) {
    aborted();
  }
  return controller.signal;
}

export async function readBoundedHistoryBody(event: H3Event, limit: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const append = (chunk: Uint8Array) => {
    size += chunk.byteLength;
    if (size > limit) {
      throw new Error("history.body_too_large");
    }
    chunks.push(chunk);
  };
  for await (const chunk of event.node.req) {
    const bytes: unknown = chunk;
    if (!Buffer.isBuffer(bytes)) {
      throw new Error("history.invalid_body_encoding");
    }
    append(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
