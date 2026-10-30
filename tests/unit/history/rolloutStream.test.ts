import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { constants, zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import * as stableRead from "#server/ingestion/stableRead.ts";
import * as decoder from "#server/ingestion/zstdRollout.ts";

import { canonicalRecords, fixtureRef } from "../../fixtures/history/nativeHistory.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rollout-stream-"));
  roots.push(root);
  const path = join(root, "source.jsonl.zst");
  const cache = join(root, "owned");
  const bytes = Buffer.from(
    canonicalRecords()
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const ref = { ...fixtureRef(path), representation: "zstd-jsonl" as const };
  await writeFile(path, zstdCompressSync(bytes));
  return { root, path, cache, bytes, ref };
}
async function foreignOpen(f: Awaited<ReturnType<typeof fixture>>): Promise<unknown> {
  const moduleUrl = pathToFileURL(resolvePath("server/ingestion/rolloutStream.ts")).href;
  const code = `import { RolloutStore } from ${JSON.stringify(moduleUrl)}; const store=new RolloutStore({cacheDirectory:${JSON.stringify(f.cache)}}); try { const lease=await store.open(${JSON.stringify(f.ref)}); process.stdout.write(JSON.stringify({text:(await lease.read(0,lease.size)).toString()})); await lease.close(); } catch(error) { process.stdout.write(JSON.stringify({error:error.message})); } finally { await store.close(); }`;
  return JSON.parse(
    (
      await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
        windowsHide: true,
      })
    ).stdout,
  );
}
describe("owned seekable rollout generations", () => {
  it("B1 retains ownership through shared-store leases, store close and a closing lease's unfinished read", async () => {
    const f = await fixture();
    const first = new RolloutStore({ cacheDirectory: f.cache });
    const second = new RolloutStore({ cacheDirectory: f.cache });
    const a = await first.open(f.ref);
    const b = await second.open(f.ref);
    await a.close();
    await first.close();
    await second.close();
    expect(await foreignOpen(f)).toEqual({ error: "rollout.cache_owned_elsewhere" });
    const actual = stableRead.readStableBytes;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(stableRead, "readStableBytes").mockImplementationOnce(async (...args) => {
      await gate;
      return actual(...args);
    });
    const pending = b.read(0, b.size);
    const closed = b.close();
    try {
      expect(await foreignOpen(f)).toEqual({ error: "rollout.cache_owned_elsewhere" });
      await expect(b.read(0, b.size)).rejects.toThrow("rollout.lease_closed");
    } finally {
      release();
      expect(await pending).toEqual(f.bytes);
      await closed;
    }
    expect(await foreignOpen(f)).toEqual({ text: f.bytes.toString() });
  });
  it("B1 retains ownership until a canceled subscriber's decoder job actually finishes", async () => {
    const f = await fixture();
    const actual = decoder.decodeZstdRollout;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(decoder, "decodeZstdRollout").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return actual(...args);
    });
    const store = new RolloutStore({ cacheDirectory: f.cache });
    const controller = new AbortController();
    const pending = store.open(f.ref, controller.signal);
    const rejected = pending.catch((error: unknown) => error);
    await started;
    controller.abort();
    expect(await rejected).toBeInstanceOf(Error);
    try {
      expect(await foreignOpen(f)).toEqual({ error: "rollout.cache_owned_elsewhere" });
    } finally {
      release();
      await store.close();
    }
    expect(await foreignOpen(f)).toEqual({ text: f.bytes.toString() });
  });
  it.each(["release", "crash"])(
    "B1 protects a cached lease in another live process until %s makes pressure reclamation possible",
    async (ending) => {
      const f = await fixture();
      const moduleUrl = pathToFileURL(resolvePath("server/ingestion/rolloutStream.ts")).href;
      const importStore = `import { RolloutStore } from ${JSON.stringify(moduleUrl)};`;
      const cacheA = `${importStore} const store = new RolloutStore({cacheDirectory:${JSON.stringify(f.cache)}}); const lease = await store.open(${JSON.stringify(f.ref)}); await lease.close(); await store.close();`;
      await promisify(execFile)(process.execPath, ["--input-type=module", "-e", cacheA], {
        windowsHide: true,
      });
      const bPath = join(f.root, "different.jsonl.zst");
      const b = Buffer.from(f.bytes.toString().replace("answer A", "answer B"));
      await writeFile(bPath, zstdCompressSync(b));
      const bRef = { ...f.ref, sourcePath: bPath, physicalRolloutId: "different" };
      const holdA = `${importStore} const store = new RolloutStore({cacheDirectory:${JSON.stringify(f.cache)}}); const lease = await store.open(${JSON.stringify(f.ref)}); process.on("message", async command => { try { if(command === "read") process.send({text:(await lease.read(0,lease.size)).toString()}); if(command === "release") { await lease.close(); process.send({released:true}); } if(command === "close-store") { await store.close(); process.send({storeClosed:true}); } } catch(error) { process.send({error:String(error)}); } }); process.send({text:(await lease.read(0,lease.size)).toString()});`;
      const reader = spawn(process.execPath, ["--input-type=module", "-e", holdA], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const pressure = `${importStore} const store = new RolloutStore({cacheDirectory:${JSON.stringify(f.cache)},maxDecodedBytes:${b.length},maxDiskBytes:${b.length + 100}}); try { const lease = await store.open(${JSON.stringify(bRef)}); process.stdout.write(JSON.stringify({text:(await lease.read(0,lease.size)).toString()})); await lease.close(); } catch(error) { process.stdout.write(JSON.stringify({error:error.message})); } finally { await store.close(); }`;
      const runPressure = async (): Promise<unknown> =>
        JSON.parse(
          (
            await promisify(execFile)(process.execPath, ["--input-type=module", "-e", pressure], {
              windowsHide: true,
            })
          ).stdout,
        );
      let exited = false;
      try {
        expect((await once(reader, "message"))[0]).toEqual({ text: f.bytes.toString() });
        let storeCloseReceipt: unknown = null;
        if (ending === "crash") {
          const storeClosed = once(reader, "message");
          reader.send("close-store");
          storeCloseReceipt = (await storeClosed)[0];
        }
        expect(storeCloseReceipt).toEqual(ending === "crash" ? { storeClosed: true } : null);
        const blocked = await runPressure();
        const reread = once(reader, "message");
        reader.send("read");
        expect((await reread)[0]).toEqual({ text: f.bytes.toString() });
        expect(blocked).toEqual({ error: "rollout.cache_owned_elsewhere" });
        let releaseReceipt: unknown = null;
        let releasedWhileAlive = false;
        if (ending === "release") {
          const released = once(reader, "message");
          reader.send("release");
          releaseReceipt = (await released)[0];
          releasedWhileAlive = reader.exitCode === null;
        } else {
          const killed = once(reader, "exit");
          reader.kill();
          await killed;
          exited = true;
        }
        expect(releaseReceipt).toEqual(ending === "release" ? { released: true } : null);
        expect(releasedWhileAlive).toBe(ending === "release");
        expect(await runPressure()).toEqual({ text: b.toString() });
      } finally {
        if (!exited) {
          const killed = once(reader, "exit");
          reader.kill();
          await killed;
        }
      }
    },
  );
  it.each(["", "-journal", "-wal", "-shm"])(
    "B1 rejects a linked control%s before touching its source target",
    async (suffix) => {
      const f = await fixture();
      await mkdir(f.cache);
      const target = join(f.root, "source-control.sqlite");
      await writeFile(target, "");
      const control = join(f.cache, `.rollout-owner.sqlite${suffix}`);
      await link(target, control);
      const before = await stat(target, { bigint: true });
      const store = new RolloutStore({ cacheDirectory: f.cache });
      await expect(store.open(f.ref)).rejects.toThrow("rollout.unsafe_cache_owner");
      expect(await readFile(target)).toEqual(Buffer.alloc(0));
      expect((await stat(target, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
      expect((await stat(target, { bigint: true })).ctimeNs).toBe(before.ctimeNs);
      await rm(control);
      await symlink(target, control, "file");
      const linked = await stat(target, { bigint: true });
      await expect(store.open(f.ref)).rejects.toThrow("rollout.unsafe_cache_owner");
      expect(await readFile(target)).toEqual(Buffer.alloc(0));
      expect((await stat(target, { bigint: true })).mtimeNs).toBe(linked.mtimeNs);
      expect((await stat(target, { bigint: true })).ctimeNs).toBe(linked.ctimeNs);
      await store.close();
    },
  );
  it.each([512, 4096])(
    "admits only an inert header-only %i-byte ownership journal",
    async (size) => {
      const f = await fixture();
      await mkdir(f.cache);
      await writeFile(join(f.cache, ".rollout-owner.sqlite"), "");
      const header = Buffer.alloc(size);
      header.writeUInt32BE(size, 20);
      header.writeUInt32BE(4096, 24);
      await writeFile(join(f.cache, ".rollout-owner.sqlite-journal"), header);
      const store = new RolloutStore({ cacheDirectory: f.cache });
      try {
        const lease = await store.open(f.ref);
        expect(await lease.read(0, lease.size)).toEqual(f.bytes);
        await lease.close();
      } finally {
        await store.close();
      }
    },
  );

  it("rejects an apparently sized journal containing page data or a hot header", async () => {
    const f = await fixture();
    await mkdir(f.cache);
    await writeFile(join(f.cache, ".rollout-owner.sqlite"), "");
    const header = Buffer.alloc(512);
    header.writeUInt32BE(512, 20);
    header.writeUInt32BE(4096, 24);
    header[100] = 1;
    await writeFile(join(f.cache, ".rollout-owner.sqlite-journal"), header);
    const store = new RolloutStore({ cacheDirectory: f.cache });
    try {
      await expect(
        store.open(f.ref).then(async (lease) => {
          await lease.close();
          return lease;
        }),
      ).rejects.toThrow("unsafe_cache_owner");
    } finally {
      await store.close();
    }
  });
  it("I5 reclaims a cold persisted generation in a fresh process while preserving a separately leased generation", async () => {
    const f = await fixture();
    const moduleUrl = pathToFileURL(resolvePath("server/ingestion/rolloutStream.ts")).href;
    const cacheA = `import { RolloutStore } from ${JSON.stringify(moduleUrl)}; const store = new RolloutStore({cacheDirectory:${JSON.stringify(f.cache)}}); const lease = await store.open(${JSON.stringify(f.ref)}); await lease.close(); await store.close();`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", cacheA], {
      windowsHide: true,
    });
    await writeFile(join(f.cache, "00000000-0000-4000-8000-000000000099.jsonl"), f.bytes);
    const b = Buffer.from(f.bytes.toString().replace("answer A", "answer B"));
    await writeFile(f.path, zstdCompressSync(b));
    const protectedPath = join(f.root, "protected.jsonl.zst");
    const protectedBytes = Buffer.from(f.bytes.toString().replace("answer A", "protected"));
    await writeFile(protectedPath, zstdCompressSync(protectedBytes));
    const protectedRef = { ...f.ref, sourcePath: protectedPath, physicalRolloutId: "protected" };
    const readB = `import { RolloutStore } from ${JSON.stringify(moduleUrl)}; const store = new RolloutStore({cacheDirectory:${JSON.stringify(f.cache)},maxDecodedBytes:${f.bytes.length},maxDiskBytes:${f.bytes.length + protectedBytes.length + 100}}); const protectedStore = new RolloutStore({cacheDirectory:${JSON.stringify(f.cache)},maxDecodedBytes:${protectedBytes.length},maxDiskBytes:${f.bytes.length + protectedBytes.length + 100}}); const protectedLease=await protectedStore.open(${JSON.stringify(protectedRef)}); const lease=await store.open(${JSON.stringify(f.ref)}); process.stdout.write(JSON.stringify({text:(await lease.read(0,lease.size)).toString(),protected:(await protectedLease.read(0,protectedLease.size)).toString()})); await lease.close(); await protectedLease.close(); await store.close(); await protectedStore.close();`;
    const result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", readB],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      text: b.toString(),
      protected: protectedBytes.toString(),
    });
  });
  it("measures first decode separately from validated warm reuse and leaves source bytes/timestamps untouched", async () => {
    const f = await fixture();
    const encoded = await readFile(f.path);
    const before = await stat(f.path, { bigint: true });
    const decode = vi.spyOn(decoder, "decodeZstdRollout");
    const store = new RolloutStore({ cacheDirectory: f.cache });
    const started = performance.now();
    const first = await store.open(f.ref);
    expect(await first.read(0, first.size)).toEqual(f.bytes);
    const firstDecodeMs = performance.now() - started;
    await first.close();
    const warmStarted = performance.now();
    const warm = await store.open(f.ref);
    expect(await warm.read(0, warm.size)).toEqual(f.bytes);
    const validatedWarmMs = performance.now() - warmStarted;
    expect(decode).toHaveBeenCalledTimes(1);
    const after = await stat(f.path, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).toBe(before.ctimeNs);
    expect(await readFile(f.path)).toEqual(encoded);
    console.info(
      JSON.stringify({
        case: "actual-production-decode",
        encodedBytes: encoded.length,
        decodedBytes: f.bytes.length,
        firstDecodeMs,
        validatedWarmMs,
      }),
    );
    await warm.close();
    await store.close();
  });
  it("enforces total owned disk budget while leasing A and retires idle A before decoding B", async () => {
    const f = await fixture();
    const store = new RolloutStore({ cacheDirectory: f.cache, maxDiskBytes: f.bytes.length + 100 });
    const a = await store.open(f.ref);
    const b = Buffer.from(f.bytes.toString().replace("answer A", "answer B"));
    await writeFile(f.path, zstdCompressSync(b));
    await expect(store.open(f.ref)).rejects.toThrow("budget");
    expect(await a.read(0, a.size)).toEqual(f.bytes);
    await a.close();
    const next = await store.open(f.ref);
    expect(await next.read(0, next.size)).toEqual(b);
    await next.close();
    await store.close();
  });
  it("cleans an abandoned owned staging generation whose process is gone", async () => {
    const f = await fixture();
    await mkdir(f.cache);
    const token = "00000000-0000-4000-8000-000000000001";
    await writeFile(join(f.cache, `${token}.stage`), "abandoned");
    await writeFile(join(f.cache, `${token}.jsonl`), "unpublished decoded bytes");
    const manifestStage = `${"a".repeat(64)}.json.${token}.stage`;
    await writeFile(join(f.cache, manifestStage), "unpublished manifest");
    await writeFile(join(f.cache, `${token}.owner`), JSON.stringify({ pid: 2147483647 }));
    const store = new RolloutStore({ cacheDirectory: f.cache });
    const lease = await store.open(f.ref);
    expect(await readdir(f.cache)).not.toContain(`${token}.stage`);
    expect(await readdir(f.cache)).not.toContain(`${token}.jsonl`);
    expect(await readdir(f.cache)).not.toContain(manifestStage);
    await lease.close();
    await store.close();
  });
  it("fences an in-flight A decode when B invalidates the family and never publishes A late", async () => {
    const f = await fixture();
    const actual = decoder.decodeZstdRollout;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    vi.spyOn(decoder, "decodeZstdRollout").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return actual(...args);
    });
    const store = new RolloutStore({ cacheDirectory: f.cache });
    const pendingA = store.open(f.ref);
    const rejectedA = pendingA.then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    const b = Buffer.from(f.bytes.toString().replace("answer A", "answer B"));
    await writeFile(f.path, zstdCompressSync(b));
    store.invalidate(f.ref);
    const pendingB = store.open(f.ref);
    release();
    expect(await rejectedA).toBeInstanceOf(Error);
    const lease = await pendingB;
    expect(await lease.read(0, lease.size)).toEqual(b);
    expect((await readdir(f.cache)).filter((file) => file.endsWith(".stage"))).toEqual([]);
    await lease.close();
    await store.close();
  });
  it("follows the stopped-viewer plain A to compressed A to plain B to same-path compressed B lifecycle", async () => {
    const f = await fixture();
    await writeFile(
      f.path,
      Buffer.concat([
        zstdCompressSync(f.bytes.subarray(0, 71)),
        zstdCompressSync(f.bytes.subarray(71)),
      ]),
    );
    const plain = f.path.replace(/\.zst$/u, "");
    const plainRef = { ...f.ref, sourcePath: plain, representation: "plain-jsonl" as const };
    await writeFile(plain, f.bytes);
    let store = new RolloutStore({ cacheDirectory: f.cache });
    let lease = await store.open(plainRef);
    expect(await lease.read(0, lease.size)).toEqual(f.bytes);
    await lease.close();
    await store.close();
    await rm(plain);
    store = new RolloutStore({ cacheDirectory: f.cache });
    lease = await store.open(f.ref);
    expect(await lease.read(0, lease.size)).toEqual(f.bytes);
    await lease.close();
    await store.close();
    const b = Buffer.from(f.bytes.toString().replace("answer A", "answer B"));
    await writeFile(plain, b);
    store = new RolloutStore({ cacheDirectory: f.cache });
    lease = await store.open({ ...f.ref, rootSessionId: null });
    expect(lease.ref.representation).toBe("plain-jsonl");
    expect(await lease.read(0, lease.size)).toEqual(b);
    await lease.close();
    await store.close();
    const old = await stat(f.path);
    const encodedB = Buffer.concat([
      zstdCompressSync(b.subarray(0, 71)),
      zstdCompressSync(b.subarray(71)),
    ]);
    expect(encodedB.length).toBe(old.size);
    await writeFile(f.path, encodedB);
    await utimes(f.path, old.atime, old.mtime);
    await rm(plain);
    store = new RolloutStore({ cacheDirectory: f.cache });
    lease = await store.open(f.ref);
    expect(await lease.read(0, lease.size)).toEqual(b);
    await lease.close();
    await store.close();
    const moduleUrl = pathToFileURL(resolvePath("server/ingestion/rolloutStream.ts")).href;
    const code = `import { RolloutStore } from ${JSON.stringify(moduleUrl)}; const store = new RolloutStore({cacheDirectory:${JSON.stringify(f.cache)}}); const lease = await store.open(${JSON.stringify(f.ref)}); process.stdout.write(JSON.stringify({text:(await lease.read(0,lease.size)).toString(),scope:lease.generation.validationScope})); await lease.close(); await store.close();`;
    const restarted = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", code],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    expect(JSON.parse(restarted.stdout)).toEqual({ text: b.toString(), scope: "full-stream" });
  });
  it("preserves semantic identity only after validating equivalent recompression and keeps cross-store leases alive", async () => {
    const f = await fixture();
    const first = new RolloutStore({ cacheDirectory: f.cache });
    const second = new RolloutStore({ cacheDirectory: f.cache });
    const a = await first.open(f.ref);
    await writeFile(
      f.path,
      zstdCompressSync(f.bytes, {
        params: { [constants.ZSTD_c_compressionLevel]: 10, [constants.ZSTD_c_contentSizeFlag]: 0 },
      }),
    );
    const b = await second.open(f.ref);
    expect(b.generation.encodedSha256).not.toBe(a.generation.encodedSha256);
    expect(b.generation.semanticEpoch).toBe(a.generation.semanticEpoch);
    expect(await a.read(0, a.size)).toEqual(f.bytes);
    await b.close();
    await a.close();
    await first.close();
    await second.close();
  });
  it("never resurrects an old compressed semantic incarnation after an observed plain replacement", async () => {
    const f = await fixture();
    const store = new RolloutStore({ cacheDirectory: f.cache });
    const a = await store.open(f.ref);
    const oldEpoch = a.generation.semanticEpoch;
    await a.close();
    const plain = f.path.slice(0, -4);
    await writeFile(plain, f.bytes.toString().replace("answer A", "answer B"));
    const b = await store.open(f.ref);
    expect((await b.read(0, b.size)).toString()).toContain("answer B");
    await b.verify();
    await b.close();
    await rm(plain);
    const returnedA = await store.open(f.ref);
    expect(returnedA.generation.semanticEpoch).not.toBe(oldEpoch);
    await returnedA.close();
    await store.close();
  });
  it("accepts skippable frames and a valid final record without newline", async () => {
    const f = await fixture();
    const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
    await writeFile(
      f.path,
      Buffer.concat([
        skip,
        zstdCompressSync(f.bytes.subarray(0, -1), {
          params: { [constants.ZSTD_c_contentSizeFlag]: 0 },
        }),
        skip,
      ]),
    );
    const store = new RolloutStore({ cacheDirectory: f.cache });
    const lease = await store.open(f.ref);
    expect(await lease.read(0, lease.size)).toEqual(f.bytes.subarray(0, -1));
    await lease.close();
    await store.close();
  });
  it("decodes actual concatenated frames, leases retired bytes and revalidates equal-size/mtime rewrites after restart", async () => {
    const f = await fixture();
    await writeFile(
      f.path,
      Buffer.concat([
        zstdCompressSync(f.bytes.subarray(0, 71)),
        zstdCompressSync(f.bytes.subarray(71)),
      ]),
    );
    const before = await readFile(f.path);
    const store = new RolloutStore({ cacheDirectory: f.cache });
    const a = await store.open(f.ref);
    expect(await a.read(0, a.size)).toEqual(f.bytes);
    expect(a.generation.validationScope).toBe("full-stream");
    expect(await readFile(f.path)).toEqual(before);
    const old = await stat(f.path);
    const b = Buffer.from(f.bytes.toString().replace("answer A", "answer B"));
    const encodedB = Buffer.concat([
      zstdCompressSync(b.subarray(0, 71)),
      zstdCompressSync(b.subarray(71)),
    ]);
    expect(encodedB.length).toBe(before.length);
    await writeFile(f.path, encodedB);
    await utimes(f.path, old.atime, old.mtime);
    const next = await store.open(f.ref);
    expect(await next.read(0, next.size)).toEqual(b);
    expect(await a.read(0, a.size)).toEqual(f.bytes);
    expect(next.generation.semanticEpoch).not.toBe(a.generation.semanticEpoch);
    await a.close();
    await next.close();
    await store.close();
    const restarted = new RolloutStore({ cacheDirectory: f.cache });
    const final = await restarted.open(f.ref);
    expect(await final.read(0, final.size)).toEqual(b);
    await final.close();
    await restarted.close();
  });
  it.each(["truncated", "junk", "malformed", "bundle", "budget"])(
    "does not publish %s output",
    async (kind) => {
      const f = await fixture();
      const encoded = await readFile(f.path);
      if (kind === "truncated") {
        await writeFile(f.path, encoded.subarray(0, -1));
      }
      if (kind === "junk") {
        await writeFile(f.path, Buffer.concat([encoded, Buffer.from("junk")]));
      }
      if (kind === "malformed") {
        await writeFile(f.path, zstdCompressSync(Buffer.concat([f.bytes, Buffer.from("bad\n")])));
      }
      if (kind === "bundle") {
        await writeFile(f.path, zstdCompressSync(Buffer.from('{"bundle":[]}\n')));
      }
      const store = new RolloutStore({
        cacheDirectory: f.cache,
        maxDecodedBytes: kind === "budget" ? 50 : 1024 * 1024,
      });
      await expect(store.open(f.ref)).rejects.toThrow(
        /end of file|trailing|Unexpected|unsupported|budget/iu,
      );
      expect((await readdir(f.cache)).filter((name) => /\.(jsonl|stage)$/u.test(name))).toEqual([]);
      await store.close();
    },
  );
  it("keeps another subscriber alive when the first cancels", async () => {
    const f = await fixture();
    const store = new RolloutStore({ cacheDirectory: f.cache });
    const controller = new AbortController();
    const canceled = store.open(f.ref, controller.signal);
    const active = store.open(f.ref);
    controller.abort();
    await expect(canceled).rejects.toThrow(/abort/iu);
    const lease = await active;
    expect(await lease.read(0, lease.size)).toEqual(f.bytes);
    await lease.close();
    await store.close();
  });
});
