import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type OutputWriteDisposition = "written" | "reused";

export function assertSafeOutputComponent(value: string): void {
  if (!/^[a-z\d](?:[a-z\d._-]{0,126}[a-z\d])?$/iu.test(value) || value === "." || value === "..") {
    throw new Error(`Expected a safe output component, received ${JSON.stringify(value)}.`);
  }
}

async function ensureUnlinkedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Viewer output directory is not an unlinked directory: ${path}`);
  }
}

async function ensureOutputParent(root: string, segments: readonly string[]): Promise<string> {
  await ensureUnlinkedDirectory(root);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    assertSafeOutputComponent(segment);
    parent = join(parent, segment);
    // oxlint-disable-next-line no-await-in-loop -- Every output path component is checked before descendant writes.
    await ensureUnlinkedDirectory(parent);
  }
  return parent;
}

async function reusableDestination(path: string, bytes: Buffer): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
      throw new Error(`Viewer output file is not an unlinked regular file: ${path}`);
    }
    return (await readFile(path)).equals(bytes);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function writeOutputFile(
  root: string,
  segments: readonly string[],
  content: string | Uint8Array,
): Promise<OutputWriteDisposition> {
  if (segments.length === 0) {
    throw new Error("Viewer output requires at least one path component.");
  }
  for (const segment of segments) {
    assertSafeOutputComponent(segment);
  }
  const parent = await ensureOutputParent(root, segments);
  const destination = join(parent, segments.at(-1)!);
  const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  if (await reusableDestination(destination, bytes)) {
    return "reused";
  }
  const temporary = join(parent, `.${segments.at(-1)!}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!(await reusableDestination(destination, bytes))) {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  if (!(await reusableDestination(destination, bytes))) {
    throw new Error(`Viewer output failed its post-write integrity check: ${destination}`);
  }
  return "written";
}

export function serializedJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
