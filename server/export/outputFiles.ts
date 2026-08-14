import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type OutputWriteDisposition = "written" | "reused";

export interface OutputStagingDirectories {
  publicRoot: string;
  buildRoot: string;
}

const TRANSIENT_RENAME_ERROR_CODES = new Set(["EBUSY", "EPERM"]);
const RENAME_RETRY_LIMIT = 5;
const RENAME_RETRY_DELAY_MS = 25;

function filesystemErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

export async function retryTransientOutputRename(
  operation: () => Promise<void>,
  wait: (durationMs: number) => Promise<unknown> = delay,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- A failed Windows rename must settle before the bounded retry.
      await operation();
      return;
    } catch (error) {
      if (
        attempt >= RENAME_RETRY_LIMIT ||
        !TRANSIENT_RENAME_ERROR_CODES.has(filesystemErrorCode(error) ?? "")
      ) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- Linear backoff gives transient file handles time to close.
      await wait((attempt + 1) * RENAME_RETRY_DELAY_MS);
    }
  }
}

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

export async function createOutputStagingDirectories(
  outputRoot: string,
): Promise<OutputStagingDirectories> {
  const parent = dirname(outputRoot);
  await ensureUnlinkedDirectory(parent);
  const token = randomUUID();
  const name = basename(outputRoot);
  const staging = {
    publicRoot: join(parent, `.${name}.${token}.tmp`),
    buildRoot: join(parent, `.${name}.${token}.nitro.tmp`),
  };
  await Promise.all([
    ensureUnlinkedDirectory(staging.publicRoot),
    ensureUnlinkedDirectory(staging.buildRoot),
  ]);
  return staging;
}

export async function discardOutputStagingDirectories(
  staging: OutputStagingDirectories,
): Promise<void> {
  await Promise.all([
    rm(staging.publicRoot, { recursive: true, force: true }),
    rm(staging.buildRoot, { recursive: true, force: true }),
  ]);
}

export async function publishStagedOutput(stagingRoot: string, outputRoot: string): Promise<void> {
  const staging = await lstat(stagingRoot);
  if (!staging.isDirectory() || staging.isSymbolicLink()) {
    throw new Error(`Viewer output staging is not an unlinked directory: ${stagingRoot}`);
  }
  const parent = dirname(outputRoot);
  await ensureUnlinkedDirectory(parent);
  const backup = join(parent, `.${basename(outputRoot)}.${randomUUID()}.backup.tmp`);
  let previousMoved = false;
  try {
    const existing = await lstat(outputRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Existing viewer output is not an unlinked directory: ${outputRoot}`);
    }
    await retryTransientOutputRename(() => rename(outputRoot, backup));
    previousMoved = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  try {
    await retryTransientOutputRename(() => rename(stagingRoot, outputRoot));
  } catch (error) {
    if (previousMoved) {
      await retryTransientOutputRename(() => rename(backup, outputRoot));
    }
    throw error;
  }
  if (previousMoved) {
    await rm(backup, { recursive: true, force: true });
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
      await retryTransientOutputRename(() => rename(temporary, destination));
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
