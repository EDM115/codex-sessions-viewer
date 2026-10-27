import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import type { JsonlRecord } from "../../server/ingestion/jsonlStream.ts";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
/** Independent expectation for the documented raw-v2 identity contract */
export function expectedRawIdentity(record: JsonlRecord, path?: string): string {
  if (path === undefined) {
    return `raw-v2-${sha(JSON.stringify(["unscoped", record.byteStart, sha(record.raw)]))}`;
  }
  const absolute = resolve(path);
  const boundary = /[\\/](?:sessions|archived_sessions)[\\/]/u.exec(absolute);
  const home = sha(boundary === null ? dirname(absolute) : absolute.slice(0, boundary.index));
  const physical =
    /(?:_|-)([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl(?:\.zst)?$/iu.exec(path)?.[1] ??
    `path:${absolute.replace(/\.zst$/u, "")}`;
  return `raw-v2-${sha(JSON.stringify([home, physical, `byte:${record.byteStart}`, sha(record.raw)]))}`;
}
