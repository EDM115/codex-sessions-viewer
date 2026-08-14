import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { createError, send, setResponseHeaders, type H3Event } from "h3";

import type { CachedContentFile } from "../cache/contentStore.ts";

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

export async function sendCachedContent(
  event: H3Event,
  content: CachedContentFile | null,
  root: string,
): Promise<void> {
  if (content === null || !isWithinRoot(root, content.path)) {
    throw createError({ statusCode: 404, statusMessage: "Cached content not found" });
  }
  const metadata = await lstat(content.path);
  const fileName = basename(content.path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    !fileName.startsWith(`${content.sha256}.`)
  ) {
    throw createError({ statusCode: 404, statusMessage: "Cached content not found" });
  }
  const bytes = await readFile(content.path);
  if (
    createHash("sha256").update(bytes).digest("hex") !== content.sha256 ||
    (content.byteSize !== null && bytes.byteLength !== content.byteSize)
  ) {
    throw createError({ statusCode: 404, statusMessage: "Cached content not found" });
  }
  setResponseHeaders(event, {
    "Cache-Control": "private, no-cache",
    "Content-Length": String(bytes.byteLength),
    "Content-Type": content.mimeType ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  await send(event, bytes);
}
