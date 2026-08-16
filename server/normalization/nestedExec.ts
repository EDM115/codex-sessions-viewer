import {
  jsonValueSchema,
  type FileChange,
  type FileChangeActivity,
  type JsonObject,
  type JsonValue,
  type ToolActivity,
} from "../../shared/types/conversation.ts";

export type NestedExecActivity = ToolActivity | FileChangeActivity;

interface NestedCall {
  input: JsonValue;
  name: string;
  offset: number;
}

class LiteralParser {
  #index = 0;
  readonly #source: string;
  readonly #constants: ReadonlyMap<string, JsonValue>;

  constructor(source: string, literalConstants: ReadonlyMap<string, JsonValue> = new Map()) {
    this.#source = source;
    this.#constants = literalConstants;
  }

  parse(): JsonValue | undefined {
    const value = this.#value();
    this.#space();
    return value === undefined || this.#index !== this.#source.length ? undefined : value;
  }

  #space(): void {
    while (/\s/u.test(this.#source[this.#index] ?? "")) {
      this.#index += 1;
    }
  }

  #value(): JsonValue | undefined {
    this.#space();
    const character = this.#source[this.#index];
    if (character === '"' || character === "'" || character === "`") {
      return this.#string(character);
    }
    if (character === "{") {
      return this.#object();
    }
    if (character === "[") {
      return this.#array();
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.#source.slice(this.#index),
    )?.[0];
    if (number !== undefined) {
      this.#index += number.length;
      const parsed = Number(number);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    const identifier = /^[A-Za-z_$][\w$]*/u.exec(this.#source.slice(this.#index))?.[0];
    if (identifier === undefined) {
      return undefined;
    }
    this.#index += identifier.length;
    if (identifier === "true") {
      return true;
    }
    if (identifier === "false") {
      return false;
    }
    if (identifier === "null") {
      return null;
    }
    return this.#constants.get(identifier);
  }

  #string(quote: string): string | undefined {
    this.#index += 1;
    let value = "";
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index++]!;
      if (character === quote) {
        return value;
      }
      if (quote === "`" && character === "$" && this.#source[this.#index] === "{") {
        return undefined;
      }
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escaped = this.#source[this.#index++];
      if (escaped === undefined) {
        return undefined;
      }
      const simple: Record<string, string> = {
        "'": "'",
        '"': '"',
        "`": "`",
        "\\": "\\",
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        0: "\0",
      };
      if (simple[escaped] !== undefined) {
        value += simple[escaped];
      } else if (escaped === "u") {
        const hexadecimal = this.#source.slice(this.#index, this.#index + 4);
        if (!/^[0-9a-f]{4}$/iu.test(hexadecimal)) {
          return undefined;
        }
        value += String.fromCodePoint(Number.parseInt(hexadecimal, 16));
        this.#index += 4;
      } else {
        value += escaped;
      }
    }
    return undefined;
  }

  #object(): JsonObject | undefined {
    this.#index += 1;
    const value: JsonObject = {};
    while (true) {
      this.#space();
      if (this.#source[this.#index] === "}") {
        this.#index += 1;
        return value;
      }
      if (this.#source.startsWith("...", this.#index) || this.#source[this.#index] === "[") {
        return undefined;
      }
      const key =
        this.#source[this.#index] === '"' ||
        this.#source[this.#index] === "'" ||
        this.#source[this.#index] === "`"
          ? this.#string(this.#source[this.#index]!)
          : /^[A-Za-z_$][\w$]*/u.exec(this.#source.slice(this.#index))?.[0];
      if (key === undefined) {
        return undefined;
      }
      if (!['"', "'", "`"].includes(this.#source[this.#index - key.length - 1] ?? "")) {
        this.#index += key.length;
      }
      this.#space();
      if (this.#source[this.#index] !== ":") {
        return undefined;
      }
      this.#index += 1;
      const child = this.#value();
      if (child === undefined) {
        return undefined;
      }
      value[key] = child;
      this.#space();
      if (this.#source[this.#index] === ",") {
        this.#index += 1;
        continue;
      }
      if (this.#source[this.#index] !== "}") {
        return undefined;
      }
    }
  }

  #array(): JsonValue[] | undefined {
    this.#index += 1;
    const value: JsonValue[] = [];
    while (true) {
      this.#space();
      if (this.#source[this.#index] === "]") {
        this.#index += 1;
        return value;
      }
      if (this.#source.startsWith("...", this.#index)) {
        return undefined;
      }
      const child = this.#value();
      if (child === undefined) {
        return undefined;
      }
      value.push(child);
      this.#space();
      if (this.#source[this.#index] === ",") {
        this.#index += 1;
        continue;
      }
      if (this.#source[this.#index] !== "]") {
        return undefined;
      }
    }
  }
}

function balancedCallEnd(source: string, open: number): number | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      } else if (quote === "`" && character === "$" && source[index + 1] === "{") {
        return null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function constants(source: string): Map<string, JsonValue> {
  const values = new Map<string, JsonValue>();
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/gu;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const start = (match.index ?? 0) + match[0].length;
    let end = start;
    let quote: string | null = null;
    let escaped = false;
    let depth = 0;
    while (end < source.length) {
      const character = source[end]!;
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
      } else if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if ("{[(".includes(character)) {
        depth += 1;
      } else if ("}])".includes(character)) {
        depth -= 1;
      } else if (depth === 0 && character === ";") {
        break;
      }
      end += 1;
    }
    const parsed = new LiteralParser(source.slice(start, end).trim(), values).parse();
    if (name !== undefined && parsed !== undefined) {
      values.set(name, parsed);
    }
  }
  return values;
}

function nestedCalls(source: string): NestedCall[] | null {
  const knownConstants = constants(source);
  const calls: NestedCall[] = [];
  const pattern = /(?:^|[^\w$])tools\.([A-Za-z_$][\w$]*)\s*\(/gu;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const matchStart = (match.index ?? 0) + match[0].lastIndexOf("tools.");
    const open = (match.index ?? 0) + match[0].lastIndexOf("(");
    const end = balancedCallEnd(source, open);
    if (name === undefined || end === null) {
      return null;
    }
    const input = new LiteralParser(source.slice(open + 1, end), knownConstants).parse();
    if (input === undefined) {
      return null;
    }
    calls.push({ name, input, offset: matchStart });
  }
  return calls.length === 0 ? null : calls.toSorted((left, right) => left.offset - right.offset);
}

function sourceCode(input: JsonValue): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    for (const key of ["code", "input", "script"] as const) {
      if (typeof input[key] === "string") {
        return input[key];
      }
    }
  }
  return null;
}

function outputTexts(value: JsonValue): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(outputTexts);
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (value["type"] === "text" && typeof value["text"] === "string") {
    return [value["text"]];
  }
  return Array.isArray(value["content"]) ? value["content"].flatMap(outputTexts) : [];
}

function parsedOutputs(value: JsonValue, count: number): JsonValue[] | null {
  if (count === 1) {
    return [value];
  }
  if (Array.isArray(value) && value.length === count) {
    return value;
  }
  const parsed = outputTexts(value).flatMap((text) => {
    const candidates = [text, ...text.split(/\r?\n/gu)].filter(Boolean);
    for (const candidate of candidates) {
      try {
        const result = jsonValueSchema.safeParse(JSON.parse(candidate));
        if (result.success) {
          return [result.data];
        }
      } catch {
        // Wrapper status prose is not a nested result record.
      }
    }
    return [];
  });
  return parsed.length === count ? parsed : null;
}

function patchFiles(patch: string): FileChange[] | null {
  if (!patch.includes("*** Begin Patch") || !patch.includes("*** End Patch")) {
    return null;
  }
  const markers = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gmu)];
  if (markers.length === 0) {
    return null;
  }
  return markers.map((marker, index) => {
    const operation = marker[1]!;
    const path = marker[2]!.trim();
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? patch.indexOf("*** End Patch", start);
    const section = patch.slice(start, end < 0 ? patch.length : end).replace(/^\r?\n/u, "");
    const move = /^\*\*\* Move to: (.+)$/mu.exec(section)?.[1]?.trim() ?? null;
    const diff = section
      .split(/\r?\n/gu)
      .filter((line) => !line.startsWith("*** Move to:"))
      .join("\n")
      .trimEnd();
    const addedLines = diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removedLines = diff
      .split("\n")
      .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return {
      path: move ?? path,
      change:
        move !== null
          ? "move"
          : operation === "Add"
            ? "add"
            : operation === "Delete"
              ? "delete"
              : "update",
      previousPath: move === null ? null : path,
      diff: diff === "" ? null : diff,
      content:
        operation === "Add"
          ? diff
              .split("\n")
              .filter((line) => line.startsWith("+"))
              .map((line) => line.slice(1))
              .join("\n")
          : null,
      addedLines,
      removedLines,
    } satisfies FileChange;
  });
}

function derivedTool(
  outer: ToolActivity,
  call: NestedCall,
  output: JsonValue,
  index: number,
): ToolActivity {
  const result =
    output !== null && typeof output === "object" && !Array.isArray(output) ? output : null;
  const exitCode = typeof result?.["exit_code"] === "number" ? result["exit_code"] : null;
  const wallTime =
    typeof result?.["wall_time_seconds"] === "number" ? result["wall_time_seconds"] : null;
  return {
    ...outer,
    id: `${outer.id}:nested-${index + 1}`,
    namespace: null,
    name: call.name,
    callId: outer.callId === null ? null : `${outer.callId}:${index + 1}`,
    status: exitCode === null ? outer.status : exitCode === 0 ? "succeeded" : "failed",
    durationMs: wallTime === null ? outer.durationMs : wallTime * 1000,
    input: call.input,
    output,
    error: exitCode !== null && exitCode !== 0 ? `Command exited with code ${exitCode}.` : null,
  };
}

export function deriveNestedExecActivities(outer: ToolActivity): NestedExecActivity[] {
  if (!(outer.namespace === "functions" && outer.name === "exec")) {
    return [outer];
  }
  const source = sourceCode(outer.input);
  if (source === null) {
    return [outer];
  }
  const calls = nestedCalls(source);
  if (calls === null) {
    return [outer];
  }
  const outputs = parsedOutputs(outer.output, calls.length);
  if (outputs === null) {
    return [outer];
  }
  const derived: NestedExecActivity[] = [];
  for (const [index, call] of calls.entries()) {
    if (call.name === "apply_patch") {
      if (typeof call.input !== "string") {
        return [outer];
      }
      const files = patchFiles(call.input);
      if (files === null) {
        return [outer];
      }
      derived.push({
        id: `${outer.id}:files-${index + 1}`,
        turnId: outer.turnId,
        createdAt: outer.createdAt,
        rawEventIds: [...outer.rawEventIds],
        kind: "file_change",
        status: outer.status,
        files,
      } satisfies FileChangeActivity);
    } else {
      derived.push(derivedTool(outer, call, outputs[index] ?? null, index));
    }
  }
  return derived.length === calls.length ? derived : [outer];
}
