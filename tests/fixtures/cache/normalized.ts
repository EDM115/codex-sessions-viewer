import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CachedSourceWrite } from "../../../server/cache/conversationStore.ts";
import { JsonlStreamParser, type JsonlRecord } from "../../../server/ingestion/jsonlStream.ts";
import {
  normalizeSession,
  NORMALIZATION_PARSER_VERSION,
  type NormalizedSession,
} from "../../../server/normalization/normalizeSession.ts";
import type { ConversationScope, SourceFingerprint } from "../../../shared/types/conversation.ts";

export async function normalizedRolloutFixture(options: {
  name: "legacy.jsonl" | "modern.jsonl";
  sourcePath: string;
  scope: ConversationScope;
  revision: string;
}): Promise<NormalizedSession> {
  const path = join(process.cwd(), "tests", "fixtures", "rollouts", options.name);
  const bytes = await readFile(path);
  const records: JsonlRecord[] = [];
  const parser = new JsonlStreamParser({ onRecord: (record) => records.push(record) });
  parser.write(bytes, 0);
  if (parser.finish().pending.byteLength !== 0) {
    throw new Error(`Expected ${options.name} to end with a complete JSONL record`);
  }
  const result = normalizeSession({
    records,
    sourcePath: options.sourcePath,
    scope: options.scope,
    sessionIndexEntries: [],
    stateSnapshot: null,
    revision: options.revision,
  });
  if (result.session === null) {
    throw new Error(`Expected ${options.name} to normalize`);
  }
  return result.session;
}

export function cachedSource(
  session: NormalizedSession,
  options: { hash?: string; inode?: bigint; size?: number } = {},
): CachedSourceWrite {
  const fingerprint: SourceFingerprint = {
    path: session.summary.sourcePath,
    size: options.size ?? 4_096,
    mtimeMs: 1_786_550_400_000,
    sha256: options.hash ?? "a".repeat(64),
    parsedBytes: options.size ?? 4_096,
    parserVersion: NORMALIZATION_PARSER_VERSION,
  };
  return {
    fingerprint,
    scope: session.summary.scope,
    identity: { device: 1n, inode: options.inode ?? 2n },
  };
}
