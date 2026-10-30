import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, opendir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as z from "zod";

import { resolveViewerPaths } from "#server/core/paths.ts";
import { sourceHomePath } from "#server/ingestion/rolloutIdentity.ts";
import {
  observeSessionMetaSource,
  readSessionMetaPrefix,
} from "#server/ingestion/sessionMetaPrefix.ts";
import {
  completeDecodedGeneration,
  validateSourceGeneration,
  validateSourceRanges,
} from "#server/ingestion/sourceGeneration.ts";
import { readStableBytes } from "#server/ingestion/stableRead.ts";
import { decodeZstdRollout, ZSTD_DECODER_VERSION } from "#server/ingestion/zstdRollout.ts";
import {
  sourceGenerationSchema,
  type RolloutRef,
  type SourceGeneration,
} from "#shared/types/conversation.ts";

export interface SeekableRollout {
  ref: RolloutRef;
  generation: SourceGeneration;
  size: number;
  readRanges(): SourceGeneration["verifiedDecodedRanges"];
  read(start: number, endExclusive: number, signal?: AbortSignal): Promise<Buffer>;
  verify(signal?: AbortSignal): Promise<SourceGeneration>;
  close(): Promise<void>;
}
export interface RolloutStoreOptions {
  cacheDirectory: string;
  maxDecodedBytes?: number;
  maxDiskBytes?: number;
  maxRecordBytes?: number;
  maxReadBytes?: number;
  windowLogMax?: number;
}
interface Artifact {
  path: string;
  generation: SourceGeneration;
  readers: number;
  retired: boolean;
}
interface Job {
  controller: AbortController;
  subscribers: number;
  promise: Promise<Artifact>;
}
const families = new Map<string, string>();
const liveArtifacts = new Map<string, Artifact>();
const cacheOwners = new Map<string, { database: DatabaseSync; references: number }>();
function inertOwnerJournal(path: string, size: number): boolean {
  if (size === 0) {
    return true;
  }
  if (![512, 1024, 2048, 4096].includes(size)) {
    return false;
  }
  const bytes = readFileSync(path);
  if (
    bytes.length !== size ||
    bytes.subarray(0, 12).some((byte) => byte !== 0) ||
    bytes.readUInt32BE(16) !== 0 ||
    bytes.subarray(28).some((byte) => byte !== 0)
  ) {
    return false;
  }
  const sector = bytes.readUInt32BE(20);
  const page = bytes.readUInt32BE(24);
  return (
    (sector === 0 || sector === size) &&
    (page === 0 || (page >= 512 && page <= 65536 && (page & (page - 1)) === 0))
  );
}
/** One OS-backed owner covers attachment, preparation, reclamation and current leases */
function acquireCacheOwner(directory: string): () => void {
  let owner = cacheOwners.get(directory);
  if (!owner) {
    const path = join(directory, ".rollout-owner.sqlite");
    try {
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size !== 0 ||
      realpathSync(path) !== path
    ) {
      throw new Error("rollout.unsafe_cache_owner");
    }
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try {
        const sidecar = path + suffix;
        const sidecarInfo = lstatSync(sidecar);
        if (
          suffix === "-journal" &&
          sidecarInfo.isFile() &&
          !sidecarInfo.isSymbolicLink() &&
          sidecarInfo.nlink === 1 &&
          sidecarInfo.size <= 4096 &&
          realpathSync(sidecar) === sidecar &&
          inertOwnerJournal(sidecar, sidecarInfo.size)
        ) {
          continue;
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      throw new Error("rollout.unsafe_cache_owner");
    }
    const database = new DatabaseSync(path, { timeout: 0 });
    try {
      // No schema/data writes, only an inert zero-page journal header (bounded to a 4096-byte sector) is admitted
      database.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      database.close();
      if (error instanceof Error && "errcode" in error && error.errcode === 5) {
        throw new Error("rollout.cache_owned_elsewhere", { cause: error });
      }
      throw error;
    }
    owner = { database, references: 0 };
    cacheOwners.set(directory, owner);
  }
  owner.references += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    owner.references -= 1;
    if (owner.references === 0) {
      // No process-local artifact remains authoritative after another process can acquire ownership
      for (const path of liveArtifacts.keys()) {
        if (dirname(path) === directory) {
          liveArtifacts.delete(path);
        }
      }
      owner.database.close();
      cacheOwners.delete(directory);
    }
  };
}
const decodedManifestSchema = z.object({
  file: z.string(),
  generation: sourceGenerationSchema,
  incarnation: z.string().nullable().optional(),
});
const ownerSchema = z.object({ pid: z.int().positive() });
async function ownedEntries(directory: string): Promise<string[]> {
  const entries: string[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (entries.length >= 4096) {
      throw new Error("rollout.cache_entry_budget");
    }
    entries.push(entry.name);
  }
  return entries;
}
let decodeQueue = Promise.resolve();
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const observationKey = (value: Awaited<ReturnType<typeof observeSessionMetaSource>>) =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? String(entry) : entry,
  );
async function plainSibling(ref: RolloutRef): Promise<RolloutRef | null> {
  if (ref.representation !== "zstd-jsonl" || !ref.sourcePath.endsWith(".jsonl.zst")) {
    return null;
  }
  const sourcePath = ref.sourcePath.slice(0, -4);
  try {
    const prefix = await readSessionMetaPrefix(sourcePath, 64 * 1024);
    return prefix.status === "found" &&
      prefix.meta?.id === ref.stableThreadId &&
      (ref.rootSessionId === null ||
        prefix.meta.rootSessionId == null ||
        prefix.meta.rootSessionId === ref.rootSessionId)
      ? {
          ...ref,
          rootSessionId: prefix.meta.rootSessionId ?? ref.rootSessionId,
          sourcePath,
          representation: "plain-jsonl",
        }
      : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export class RolloutStore {
  readonly #options: Required<RolloutStoreOptions>;
  readonly #jobs = new Map<string, Job>();
  readonly #requests = new Set<Promise<Artifact>>();
  #closed = false;
  constructor(options: RolloutStoreOptions) {
    this.#options = {
      maxDecodedBytes: 2 * 1024 ** 3,
      maxDiskBytes: 4 * 1024 ** 3,
      maxRecordBytes: 1024 * 1024,
      maxReadBytes: 2 * 1024 * 1024,
      windowLogMax: 27,
      ...options,
    };
    for (const [key, value] of Object.entries(this.#options)) {
      if (key !== "cacheDirectory" && (!Number.isSafeInteger(value) || Number(value) < 1)) {
        throw new RangeError(`Invalid ${key}`);
      }
    }
  }
  #familyKey(ref: RolloutRef): string {
    return join(
      this.#options.cacheDirectory,
      digest(
        JSON.stringify([
          ref.codexHomeId,
          ref.physicalRolloutId,
          resolve(ref.sourcePath).replace(/\.zst$/u, ""),
        ]),
      ),
    );
  }
  invalidate(ref: RolloutRef): void {
    families.set(this.#familyKey(ref), randomUUID());
    const key = JSON.stringify([ref.codexHomeId, ref.physicalRolloutId, resolve(ref.sourcePath)]);
    this.#jobs.get(key)?.controller.abort();
    this.#jobs.delete(key);
  }
  async open(ref: RolloutRef, signal?: AbortSignal): Promise<SeekableRollout> {
    signal?.throwIfAborted();
    if (this.#closed) {
      throw new Error("rollout.store_closed");
    }
    if (
      ref.representation === "unsupported" ||
      !(ref.representation === "plain-jsonl" ? /\.jsonl$/u : /\.jsonl\.zst$/u).test(ref.sourcePath)
    ) {
      throw new Error("rollout.unsupported_format");
    }
    const sibling = await plainSibling(ref);
    signal?.throwIfAborted();
    if (sibling) {
      ref = sibling;
    }
    const source = resolve(ref.sourcePath);
    let existing = resolve(this.#options.cacheDirectory);
    const missing: string[] = [];
    let owned: string;
    while (true) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Resolve the nearest existing owner directory before creating any path
        owned = join(await realpath(existing), ...missing);
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT" ||
          dirname(existing) === existing
        ) {
          throw error;
        }
        missing.unshift(basename(existing));
        existing = dirname(existing);
      }
    }
    if (!relative(owned, source).startsWith("..")) {
      throw new Error("rollout.source_cache_overlap");
    }
    if (/[\\/](?:sessions|archived_sessions)[\\/]/u.test(source)) {
      const sourceHome = await realpath(sourceHomePath(source));
      if (!relative(sourceHome, owned).startsWith("..")) {
        throw new Error("rollout.source_cache_overlap");
      }
    }
    this.#options.cacheDirectory = owned;
    if (this.#closed) {
      throw new Error("rollout.store_closed");
    }
    await mkdir(owned, { recursive: true });
    signal?.throwIfAborted();
    const releaseOwner = acquireCacheOwner(owned);
    try {
      const lease = await this.#openOwned(ref, signal);
      const operations = new Set<Promise<unknown>>();
      let closing: Promise<void> | undefined;
      const track = <T>(operation: () => Promise<T>): Promise<T> => {
        if (closing) {
          return Promise.reject(new Error("rollout.lease_closed"));
        }
        const running = operation();
        operations.add(running);
        void running.then(
          () => operations.delete(running),
          () => operations.delete(running),
        );
        return running;
      };
      return {
        ...lease,
        read: (start, end, readSignal) => track(() => lease.read(start, end, readSignal)),
        verify: (verifySignal) => track(() => lease.verify(verifySignal)),
        close: () => {
          closing ??= (async () => {
            try {
              await Promise.allSettled(operations);
              await lease.close();
            } finally {
              releaseOwner();
            }
          })();
          return closing;
        },
      };
    } catch (error) {
      releaseOwner();
      throw error;
    }
  }
  async #openOwned(ref: RolloutRef, signal?: AbortSignal): Promise<SeekableRollout> {
    if (this.#closed) {
      throw new Error("rollout.store_closed");
    }
    if (ref.representation === "plain-jsonl") {
      return this.#plain(ref, signal);
    }
    const key = JSON.stringify([ref.codexHomeId, ref.physicalRolloutId, resolve(ref.sourcePath)]);
    let job = this.#jobs.get(key);
    if (job?.controller.signal.aborted) {
      job = undefined;
    }
    if (!job) {
      const controller = new AbortController();
      const releaseJobOwner = acquireCacheOwner(this.#options.cacheDirectory);
      const run = decodeQueue
        .then(() => this.#prepare(ref, controller.signal))
        .finally(releaseJobOwner);
      decodeQueue = run.then(
        () => undefined,
        () => undefined,
      );
      const own: Job = {
        controller,
        subscribers: 0,
        promise: run.finally(() => {
          if (this.#jobs.get(key) === own) {
            this.#jobs.delete(key);
          }
        }),
      };
      job = own;
      this.#jobs.set(key, own);
      this.#requests.add(own.promise);
      void own.promise.then(
        () => this.#requests.delete(own.promise),
        () => this.#requests.delete(own.promise),
      );
    }
    job.subscribers += 1;
    const shared = job;
    let abort: (() => void) | undefined;
    try {
      const canceled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason ?? new Error("rollout.canceled"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
        }
      });
      const artifact = await Promise.race([shared.promise, canceled]);
      signal?.throwIfAborted();
      artifact.readers += 1;
      const generation = artifact.generation;
      let closed = false;
      const ranges = new Map<string, SourceGeneration["verifiedDecodedRanges"][number]>();
      return {
        ref,
        generation,
        size: generation.decodedSize!,
        readRanges: () => [...ranges.values()],
        read: async (start, end, readSignal) => {
          if (closed) {
            throw new Error("rollout.lease_closed");
          }
          const bytes = await this.#read(artifact.path, start, end, readSignal);
          ranges.set(`${start}:${end}`, { start, endExclusive: end, sha256: digest(bytes) });
          return bytes;
        },
        verify: async (verifySignal) => {
          const validated = await validateSourceGeneration(ref, generation, verifySignal, {
            decoderVersion: ZSTD_DECODER_VERSION,
          });
          if (validated.generation.encodedSha256 !== generation.encodedSha256) {
            throw new Error("rollout.source_changed");
          }
          return generation;
        },
        close: async () => {
          if (closed) {
            return;
          }
          closed = true;
          artifact.readers -= 1;
          if (artifact.retired && artifact.readers === 0) {
            await this.#remove(artifact);
          }
        },
      };
    } finally {
      if (abort) {
        signal?.removeEventListener("abort", abort);
      }
      shared.subscribers -= 1;
      if (shared.subscribers === 0) {
        shared.controller.abort();
      }
    }
  }
  async #read(path: string, start: number, end: number, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    if (end - start > this.#options.maxReadBytes) {
      throw new Error("rollout.read_budget");
    }
    const result = await readStableBytes(path, { start, endExclusive: end });
    signal?.throwIfAborted();
    if (result.read.status !== "stable") {
      throw new Error("rollout.source_changed");
    }
    return result.bytes;
  }
  async #plain(ref: RolloutRef, signal?: AbortSignal): Promise<SeekableRollout> {
    const family = this.#familyKey(ref);
    const incarnation = randomUUID();
    families.set(family, incarnation);
    await mkdir(this.#options.cacheDirectory, { recursive: true });
    const markerStage = `${family}.${incarnation}.stage`;
    try {
      await writeFile(markerStage, incarnation, { flag: "wx" });
      renameSync(markerStage, `${family}.incarnation`);
    } finally {
      await rm(markerStage, { force: true });
    }
    const before = await observeSessionMetaSource(ref.sourcePath);
    const initial = (await validateSourceRanges(ref, [], null, signal)).generation;
    const ranges = new Map<string, SourceGeneration["verifiedDecodedRanges"][number]>();
    let closed = false;
    return {
      ref,
      generation: initial,
      size: Number(before.size),
      readRanges: () => [...ranges.values()],
      read: async (start, endExclusive, readSignal) => {
        if (closed) {
          throw new Error("rollout.lease_closed");
        }
        const bytes = await this.#read(ref.sourcePath, start, endExclusive, readSignal);
        ranges.set(`${start}:${endExclusive}`, { start, endExclusive, sha256: digest(bytes) });
        return bytes;
      },
      verify: async (verifySignal) => {
        const expected = [...ranges.values()];
        const next = (await validateSourceRanges(ref, expected, null, verifySignal)).generation;
        if (
          observationKey(before) !==
            observationKey(await observeSessionMetaSource(ref.sourcePath)) ||
          next.verifiedDecodedRanges.some(
            (range, index) => range.sha256 !== expected[index]!.sha256,
          )
        ) {
          throw new Error("rollout.source_changed");
        }
        return next;
      },
      close: async () => {
        closed = true;
      },
    };
  }
  async #prepare(ref: RolloutRef, signal: AbortSignal): Promise<Artifact> {
    signal.throwIfAborted();
    await mkdir(this.#options.cacheDirectory, { recursive: true });
    await this.#cleanAbandoned();
    const familyKey = this.#familyKey(ref);
    const token = randomUUID();
    families.set(familyKey, token);
    const manifest = `${familyKey}.json`;
    const incarnation = await readFile(`${familyKey}.incarnation`, "utf8").catch(() => null);
    let prior: { path: string; generation: SourceGeneration } | null = null;
    try {
      const saved = decodedManifestSchema.parse(JSON.parse(await readFile(manifest, "utf8")));
      if (basename(saved.file) === saved.file && /^[\da-f-]+\.jsonl$/u.test(saved.file)) {
        prior = {
          path: join(this.#options.cacheDirectory, saved.file),
          generation: sourceGenerationSchema.parse(saved.generation),
        };
      }
      if (prior && (saved.incarnation ?? null) !== incarnation) {
        prior.generation = { ...prior.generation, semanticEpoch: randomUUID() };
      }
    } catch {
      /* A missing or invalid owned manifest is rebuilt from source */
    }
    const validated = await validateSourceGeneration(ref, prior?.generation ?? null, signal, {
      decoderVersion: ZSTD_DECODER_VERSION,
    });
    if (prior && validated.reuse === "decoded") {
      try {
        const existing = liveArtifacts.get(prior.path);
        if (existing) {
          if (await plainSibling(ref)) {
            throw new Error("rollout.source_changed_to_plain");
          }
          await this.#publish(
            manifest,
            prior.path,
            validated.generation,
            incarnation,
            familyKey,
            token,
            signal,
          );
          existing.generation = validated.generation;
          return existing;
        }
        const check = await validateSourceGeneration(
          { ...ref, sourcePath: prior.path, representation: "plain-jsonl" },
          null,
          signal,
        );
        if (check.generation.decodedSha256 === prior.generation.decodedSha256) {
          if (await plainSibling(ref)) {
            throw new Error("rollout.source_changed_to_plain");
          }
          await this.#publish(
            manifest,
            prior.path,
            validated.generation,
            incarnation,
            familyKey,
            token,
            signal,
          );
          const artifact = {
            ...prior,
            generation: validated.generation,
            readers: 0,
            retired: false,
          };
          liveArtifacts.set(prior.path, artifact);
          return artifact;
        }
      } catch {
        signal.throwIfAborted();
      }
    }
    await this.#evict();
    await this.#cleanAbandoned();
    let files = await ownedEntries(this.#options.cacheDirectory);
    const sizes = await Promise.all(
      files
        .filter((file) => /\.(jsonl|stage)$/u.test(file))
        .map(async (file) => (await stat(join(this.#options.cacheDirectory, file))).size),
    );
    let available = this.#options.maxDiskBytes - sizes.reduce((sum, size) => sum + size, 0);
    if (available < this.#options.maxDecodedBytes) {
      for (const artifact of liveArtifacts.values()) {
        if (
          artifact.readers !== 0 ||
          resolve(dirname(artifact.path)) !== resolve(this.#options.cacheDirectory)
        ) {
          continue;
        }
        artifact.retired = true;
        // oxlint-disable-next-line no-await-in-loop -- Eviction must finish before reclaiming this generation's disk allocation
        await this.#remove(artifact);
      }
      this.#reclaimCold(files);
      files = await ownedEntries(this.#options.cacheDirectory);
      const remaining = await Promise.all(
        files
          .filter((file) => /\.(jsonl|stage)$/u.test(file))
          .map(async (file) => (await stat(join(this.#options.cacheDirectory, file))).size),
      );
      available = this.#options.maxDiskBytes - remaining.reduce((sum, size) => sum + size, 0);
    }
    if (available <= 0) {
      throw new Error("rollout.decoded_disk_budget");
    }
    const stage = join(this.#options.cacheDirectory, `${token}.stage`);
    const destination = join(this.#options.cacheDirectory, `${token}.jsonl`);
    const owner = join(this.#options.cacheDirectory, `${token}.owner`);
    try {
      await writeFile(owner, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      const decoded = await decodeZstdRollout(
        ref,
        stage,
        {
          maxDecodedBytes: Math.min(available, this.#options.maxDecodedBytes),
          maxRecordBytes: this.#options.maxRecordBytes,
          windowLogMax: this.#options.windowLogMax,
        },
        signal,
      );
      const after = await validateSourceGeneration(ref, null, signal, {
        decoderVersion: ZSTD_DECODER_VERSION,
      });
      if (
        after.generation.encodedSha256 !== decoded.encodedSha256 ||
        decoded.encodedSha256 !== validated.generation.encodedSha256 ||
        JSON.stringify(after.generation.observation) !==
          JSON.stringify(validated.generation.observation)
      ) {
        throw new Error("rollout.source_changed");
      }
      const generation = completeDecodedGeneration(
        after.generation,
        { ...decoded, decoderVersion: ZSTD_DECODER_VERSION },
        prior?.generation ?? null,
      );
      if (await plainSibling(ref)) {
        throw new Error("rollout.source_changed_to_plain");
      }
      signal.throwIfAborted();
      if (families.get(familyKey) !== token) {
        throw new Error("rollout.superseded");
      }
      await rename(stage, destination);
      await this.#publish(manifest, destination, generation, incarnation, familyKey, token, signal);
      const artifact = { path: destination, generation, readers: 0, retired: false };
      liveArtifacts.set(destination, artifact);
      if (prior) {
        const old = liveArtifacts.get(prior.path);
        if (old) {
          old.retired = true;
          if (old.readers === 0) {
            await this.#remove(old);
          }
        } else {
          await rm(prior.path, { force: true });
        }
      }
      return artifact;
    } catch (error) {
      await Promise.all([stage, destination].map((path) => rm(path, { force: true })));
      throw error;
    } finally {
      await rm(owner, { force: true });
    }
  }
  #reclaimCold(files: readonly string[]): void {
    const references = new Map<string, string[]>();
    for (const name of files) {
      if (!/^[\da-f]{64}\.json$/u.test(name)) {
        continue;
      }
      const manifest = join(this.#options.cacheDirectory, name);
      try {
        const saved = decodedManifestSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
        if (!/^[\da-f-]{36}\.jsonl$/u.test(saved.file) || basename(saved.file) !== saved.file) {
          continue;
        }
        const paths = references.get(saved.file) ?? [];
        paths.push(manifest);
        references.set(saved.file, paths);
      } catch {
        /* Only validated owned manifests can authorize reference retirement */
      }
    }
    const candidates = new Set([
      ...references.keys(),
      ...files.filter((name) => /^[\da-f-]{36}\.jsonl$/u.test(name)),
    ]);
    for (const file of candidates) {
      try {
        const path = join(this.#options.cacheDirectory, file);
        if ((liveArtifacts.get(path)?.readers ?? 0) > 0) {
          continue;
        }
        const owner = join(this.#options.cacheDirectory, file.replace(/\.jsonl$/u, ".owner"));
        let protectedOwner = false;
        try {
          const marker = ownerSchema.parse(JSON.parse(readFileSync(owner, "utf8")));
          try {
            process.kill(marker.pid, 0);
            protectedOwner = true;
          } catch (error) {
            protectedOwner =
              !(error instanceof Error) || !("code" in error) || error.code !== "ESRCH";
          }
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            protectedOwner = true;
          }
        }
        if (protectedOwner) {
          continue;
        }
        // Keep the final live-reader check, artifact retirement and matching manifest removal indivisible within the cache owner
        if ((liveArtifacts.get(path)?.readers ?? 0) > 0) {
          continue;
        }
        rmSync(path, { force: true });
        for (const manifest of references.get(file) ?? []) {
          const current = decodedManifestSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
          if (current.file === file) {
            rmSync(manifest, { force: true });
          }
        }
        liveArtifacts.delete(path);
      } catch {
        /* An invalid, protected or concurrently unavailable generation is not an eviction candidate */
      }
    }
  }
  async #cleanAbandoned(): Promise<void> {
    const files = await ownedEntries(this.#options.cacheDirectory);
    const referenced = new Set<string>();
    for (const file of files) {
      if (!/^[\da-f]{64}\.json$/u.test(file)) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- Read one bounded manifest before deciding whether a dead owner's decoded file was published
        const content = await readFile(join(this.#options.cacheDirectory, file), "utf8");
        const metadata = decodedManifestSchema.parse(JSON.parse(content));
        referenced.add(metadata.file);
      } catch {
        /* Invalid manifests do not establish a live generation */
      }
    }
    for (const name of files) {
      if (!/^[\da-f-]{36}\.owner$/u.test(name)) {
        continue;
      }
      const owner = join(this.#options.cacheDirectory, name);
      try {
        // oxlint-disable-next-line no-await-in-loop -- Each owned process marker is inspected before deleting only its own staging path
        const value = ownerSchema.parse(JSON.parse(await readFile(owner, "utf8")));
        if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
          continue;
        }
        try {
          process.kill(value.pid, 0);
          continue;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
            continue;
          }
        }
        // oxlint-disable-next-line no-await-in-loop -- A dead owner's staging file is removed before its ownership marker
        await rm(join(this.#options.cacheDirectory, name.replace(/\.owner$/u, ".stage")), {
          force: true,
        });
        const decodedName = name.replace(/\.owner$/u, ".jsonl");
        const decodedPath = join(this.#options.cacheDirectory, decodedName);
        if (!referenced.has(decodedName) && !liveArtifacts.has(decodedPath)) {
          // oxlint-disable-next-line no-await-in-loop -- A generation renamed before publication is still owned by the dead staging process
          await rm(decodedPath, { force: true });
        }
        const token = name.slice(0, -6);
        const abandonedManifests = files.filter(
          (file) => /^[\da-f]{64}\.json\./u.test(file) && file.endsWith(`.${token}.stage`),
        );
        // oxlint-disable-next-line no-await-in-loop -- Remove only manifest stages carrying this already-verified dead owner's generation token
        await Promise.all(
          abandonedManifests.map((file) =>
            rm(join(this.#options.cacheDirectory, file), { force: true }),
          ),
        );
        // oxlint-disable-next-line no-await-in-loop -- Only the already-validated dead process marker is removed
        await rm(owner, { force: true });
      } catch {
        /* Invalid markers cannot authorize deleting any artifact */
      }
    }
  }
  async #publish(
    manifest: string,
    path: string,
    generation: SourceGeneration,
    incarnation: string | null,
    family: string,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    const stage = `${manifest}.${token}.stage`;
    try {
      await writeFile(stage, JSON.stringify({ file: basename(path), generation, incarnation }), {
        flag: "wx",
      });
      signal.throwIfAborted();
      if (families.get(family) !== token) {
        throw new Error("rollout.superseded");
      }
      renameSync(stage, manifest);
    } finally {
      await rm(stage, { force: true });
    }
  }
  async #remove(artifact: Artifact): Promise<void> {
    await rm(artifact.path, { force: true });
    liveArtifacts.delete(artifact.path);
  }
  async #evict(): Promise<void> {
    await Promise.all(
      [...liveArtifacts.values()]
        .filter(
          (artifact) =>
            artifact.retired &&
            artifact.readers === 0 &&
            resolve(dirname(artifact.path)) === resolve(this.#options.cacheDirectory),
        )
        .map((artifact) => this.#remove(artifact)),
    );
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) {
      job.controller.abort();
    }
    await Promise.allSettled(this.#requests);
    if (cacheOwners.has(this.#options.cacheDirectory)) {
      const releaseOwner = acquireCacheOwner(this.#options.cacheDirectory);
      try {
        await this.#evict();
      } finally {
        releaseOwner();
      }
    }
  }
}
let defaultStore: RolloutStore | undefined;
export function openRollout(ref: RolloutRef, signal?: AbortSignal): Promise<SeekableRollout> {
  defaultStore ??= new RolloutStore({
    cacheDirectory: join(resolveViewerPaths().cacheDir, "decoded-rollouts"),
  });
  return defaultStore.open(ref, signal);
}
