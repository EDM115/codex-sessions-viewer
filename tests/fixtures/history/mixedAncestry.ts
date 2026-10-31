import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

export const ancestryThread = "11111111-1111-4111-8111-111111111111";
export const ancestryBasePhysical = "22222222-2222-4222-8222-222222222222";
export const ancestryLeafPhysical = "33333333-3333-4333-8333-333333333333";
export function ancestryRecords(
  id: string,
  turn: string,
  answer: string,
): { type: string; payload: Record<string, unknown> }[] {
  return [
    { type: "session_meta", payload: { id, source: "cli", thread_source: "user" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { type: "event_msg", payload: { type: "user_message", message: `question ${turn}` } },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: `${turn}-answer`,
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: answer }],
      },
    },
    {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turn, last_agent_message: answer },
    },
  ];
}
export const jsonl = (records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
export async function mixedAncestryFixture(
  home: string,
  options: { compressed?: boolean; crossThread?: boolean; padding?: number } = {},
) {
  await mkdir(join(home, "sessions"), { recursive: true });
  const baseThread = options.crossThread ? "44444444-4444-4444-8444-444444444444" : ancestryThread;
  const basePath = join(
    home,
    `sessions/rollout-2026-10-01T10-00-00-${baseThread}_${ancestryBasePhysical}.jsonl${options.compressed ? ".zst" : ""}`,
  );
  const leafPath = join(
    home,
    `sessions/rollout-2026-10-02T10-00-00-${ancestryThread}_${ancestryLeafPhysical}.jsonl`,
  );
  const baseRecords = ancestryRecords(baseThread, "base-turn", "ANCESTOR_A");
  if (options.padding) {
    baseRecords.splice(1, 0, {
      type: "turn_context",
      payload: { model: "ancestor-model", padding: "p".repeat(options.padding) },
    });
  }
  const baseText = jsonl(baseRecords);
  const excluded = jsonl(ancestryRecords(baseThread, "excluded-turn", "EXCLUDED_SUFFIX").slice(1));
  const writeBase = async (answer = "ANCESTOR_A") => {
    const bytes = Buffer.from((baseText + excluded).replaceAll("ANCESTOR_A", answer));
    await writeFile(basePath, options.compressed ? zstdCompressSync(bytes) : bytes);
    return bytes;
  };
  const originalBase = await writeBase();
  const leafRecords = ancestryRecords(ancestryThread, "leaf-turn", "LEAF_ANSWER");
  leafRecords[0]!.payload["history_base"] = {
    thread_id: ancestryBasePhysical,
    end_ordinal_exclusive: baseRecords.length,
    end_byte_offset: Buffer.byteLength(baseText),
  };
  if (options.crossThread) {
    leafRecords[0]!.payload["subagent_history_start_ordinal"] = baseRecords.length + 1;
  }
  await writeFile(leafPath, jsonl(leafRecords));
  return { home, basePath, leafPath, baseRecords, leafRecords, originalBase, writeBase };
}
