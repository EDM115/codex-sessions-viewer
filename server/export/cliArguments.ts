export interface ExportArguments {
  codexHome?: string | undefined;
  output?: string | undefined;
  offline: boolean;
  force: boolean;
  index: boolean;
  trustedMediaRoots?: string[] | undefined;
}

export interface DoctorArguments {
  codexHome?: string | undefined;
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseExportArguments(args: readonly string[]): ExportArguments {
  const parsed: ExportArguments = { offline: false, force: false, index: true };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--offline") {
      parsed.offline = true;
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--no-index") {
      parsed.index = false;
    } else if (
      argument === "--codex-home" ||
      argument === "--output" ||
      argument === "--media-root"
    ) {
      const value = optionValue(args, index, argument);
      if (argument === "--codex-home") {
        parsed.codexHome = value;
      } else if (argument === "--media-root") {
        (parsed.trustedMediaRoots ??= []).push(value);
      } else {
        parsed.output = value;
      }
      index += 1;
    } else if (argument.startsWith("--codex-home=")) {
      parsed.codexHome = argument.slice("--codex-home=".length);
    } else if (argument.startsWith("--output=")) {
      parsed.output = argument.slice("--output=".length);
    } else if (argument.startsWith("--media-root=")) {
      (parsed.trustedMediaRoots ??= []).push(argument.slice("--media-root=".length));
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (parsed.codexHome === "") {
    throw new Error("--codex-home requires a value");
  }
  if (parsed.output === "") {
    throw new Error("--output requires a value");
  }
  if (parsed.trustedMediaRoots?.some((path) => path === "")) {
    throw new Error("--media-root requires a value");
  }
  return parsed;
}

export function parseDoctorArguments(args: readonly string[]): DoctorArguments {
  if (args.length === 0) {
    return {};
  }
  const argument = args[0]!;
  if (argument === "--codex-home") {
    const value = args[1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--codex-home requires a value");
    }
    if (args.length !== 2) {
      throw new Error(`Unknown option: ${args[2]}`);
    }
    return { codexHome: value };
  }
  if (argument.startsWith("--codex-home=")) {
    const value = argument.slice("--codex-home=".length);
    if (value === "") {
      throw new Error("--codex-home requires a value");
    }
    if (args.length !== 1) {
      throw new Error(`Unknown option: ${args[1]}`);
    }
    return { codexHome: value };
  }
  throw new Error(`Unknown option: ${argument}`);
}
