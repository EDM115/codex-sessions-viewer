import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlStreamParser,
  readStableJsonl,
  type JsonlRecord,
} from "../../../server/ingestion/jsonlStream.ts";
import { stableRead } from "../../../server/ingestion/stableRead.ts";

const temporaryDirectories: string[] = [];

async function temporaryFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-viewer-jsonl-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, contents, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("JSONL byte streaming", () => {
  it("decodes LF and CRLF records when UTF-8 code points are split across chunks", () => {
    const records: JsonlRecord[] = [];
    const parser = new JsonlStreamParser({ onRecord: (record) => records.push(record) });
    const input = Buffer.from('{"text":"café ☕"}\r\n{"text":"done"}\n', "utf8");
    const splitInsideCoffee = input.indexOf(Buffer.from("☕")) + 1;

    parser.write(input.subarray(0, splitInsideCoffee), 0);
    parser.write(input.subarray(splitInsideCoffee, splitInsideCoffee + 1), splitInsideCoffee);
    parser.write(input.subarray(splitInsideCoffee + 1), splitInsideCoffee + 1);
    const state = parser.finish();

    expect(records.map(({ value }) => value)).toEqual([{ text: "café ☕" }, { text: "done" }]);
    expect(records.map(({ lineNumber, byteStart }) => ({ lineNumber, byteStart }))).toEqual([
      { lineNumber: 1, byteStart: 0 },
      { lineNumber: 2, byteStart: Buffer.byteLength('{"text":"café ☕"}\r\n') },
    ]);
    expect(state.pending).toEqual(Buffer.alloc(0));
    expect(state.nextLineNumber).toBe(3);
    expect(state.nextOffset).toBe(input.byteLength);
  });

  it("continues after an invalid interior record and accepts a huge individual line", () => {
    const records: JsonlRecord[] = [];
    const errors: Array<{ lineNumber: number; reason: string }> = [];
    const parser = new JsonlStreamParser({
      onRecord: (record) => records.push(record),
      onError: ({ lineNumber, reason }) => errors.push({ lineNumber, reason }),
    });
    const hugeText = "x".repeat(1024 * 1024 + 17);
    const input = Buffer.from(`{"ok":1}\nnot-json\n{"huge":"${hugeText}"}\n`, "utf8");

    for (let offset = 0; offset < input.byteLength; offset += 8191) {
      parser.write(input.subarray(offset, offset + 8191), offset);
    }
    parser.finish();

    expect(errors).toEqual([{ lineNumber: 2, reason: "invalid-json" }]);
    expect(records).toHaveLength(2);
    expect(records[1]?.value).toEqual({ huge: hugeText });
  });

  it("counts blank physical lines without emitting records and rejects non-contiguous chunks", () => {
    const records: JsonlRecord[] = [];
    const parser = new JsonlStreamParser({ onRecord: (record) => records.push(record) });
    const input = Buffer.from('\n{"id":1}\n', "utf8");

    parser.write(input, 0);

    expect(records).toEqual([expect.objectContaining({ lineNumber: 2, value: { id: 1 } })]);
    expect(() => parser.write(Buffer.from("{}\n"), input.byteLength + 1)).toThrow(
      "must be contiguous",
    );
  });

  it("preserves and resumes an incomplete final record without changing its byte origin", () => {
    const firstRecords: JsonlRecord[] = [];
    const first = new JsonlStreamParser({ onRecord: (record) => firstRecords.push(record) });
    const initial = Buffer.from('{"id":1}\n{"id":', "utf8");

    first.write(initial, 0);
    const pendingState = first.finish();

    expect(firstRecords.map(({ value }) => value)).toEqual([{ id: 1 }]);
    expect(pendingState).toMatchObject({
      pendingStart: Buffer.byteLength('{"id":1}\n'),
      nextLineNumber: 2,
      nextOffset: initial.byteLength,
    });
    expect(pendingState.pending.toString("utf8")).toBe('{"id":');

    const resumedRecords: JsonlRecord[] = [];
    const resumed = new JsonlStreamParser({
      state: pendingState,
      onRecord: (record) => resumedRecords.push(record),
    });
    const suffix = Buffer.from("2}\n", "utf8");
    resumed.write(suffix, initial.byteLength);
    const completedState = resumed.finish();

    expect(resumedRecords).toEqual([
      expect.objectContaining({
        lineNumber: 2,
        byteStart: pendingState.pendingStart,
        value: { id: 2 },
      }),
    ]);
    expect(completedState.pending).toEqual(Buffer.alloc(0));
    expect(completedState.nextLineNumber).toBe(3);
  });

  it("returns no parsed records when the source changes during a stable file read", async () => {
    const path = await temporaryFile('{"id":1}\n{"id":2}\n');
    let changed = false;

    const result = await readStableJsonl(path, {
      chunkSize: 5,
      async afterChunk() {
        if (!changed) {
          changed = true;
          await appendFile(path, '{"id":3}\n', "utf8");
        }
      },
    });

    expect(result.read).toMatchObject({ status: "changed", retry: true });
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.state.pending).toEqual(Buffer.alloc(0));
  });

  it("propagates the full-reparse condition when a persisted offset was truncated", async () => {
    const path = await temporaryFile('{"id":1}\n');

    const result = await readStableJsonl(path, { start: 100 });

    expect(result.read).toMatchObject({ status: "full-reparse", reason: "truncated" });
    expect(result.records).toEqual([]);
  });

  it("rejects parser state that does not end at the requested offset", async () => {
    const path = await temporaryFile('{"id":1}\n');

    await expect(
      readStableJsonl(path, {
        start: 0,
        state: {
          pending: Buffer.alloc(0),
          pendingStart: 1,
          nextLineNumber: 2,
          nextOffset: 1,
        },
      }),
    ).rejects.toThrow("must end at the requested read offset");
  });

  it("validates stable-read ranges and persisted prefixes before streaming", async () => {
    const path = await temporaryFile("abcdef");

    await expect(stableRead(path, { start: -1 })).rejects.toThrow("start must be");
    await expect(stableRead(path, { chunkSize: 0 })).rejects.toThrow(
      "chunkSize must be greater than zero",
    );
    await expect(stableRead(path, { start: 4, endExclusive: 3 })).rejects.toThrow(
      "must not be less than start",
    );
    await expect(stableRead(path, { endExclusive: 7 })).resolves.toMatchObject({
      status: "full-reparse",
      reason: "truncated",
    });
    await expect(
      stableRead(path, {
        expectedPrefix: { offset: 4, bytes: Buffer.from("def") },
      }),
    ).resolves.toMatchObject({ status: "full-reparse", reason: "truncated" });
    await expect(
      stableRead(path, {
        expectedPrefix: { offset: 0, bytes: Buffer.from("ABC") },
      }),
    ).resolves.toMatchObject({ status: "full-reparse", reason: "prefix-mismatch" });
  });
});
