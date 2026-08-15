import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export class InvalidStaticPayloadPathError extends Error {
  constructor() {
    super("The static payload path is invalid.");
    this.name = "InvalidStaticPayloadPathError";
  }
}

export async function readStaticPayloadInput(
  publicInputRoot: string,
  requestPath: string,
): Promise<unknown> {
  if (
    requestPath === "" ||
    !requestPath.endsWith(".json") ||
    requestPath.includes("\\") ||
    requestPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new InvalidStaticPayloadPathError();
  }
  const payloadRoot = resolve(publicInputRoot, "payloads");
  const target = resolve(payloadRoot, ...requestPath.split("/"));
  const relativeTarget = relative(payloadRoot, target);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new InvalidStaticPayloadPathError();
  }
  return JSON.parse(await readFile(target, "utf8")) as unknown;
}
