import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, defineEventHandler, toNodeListener } from "h3";
import { afterEach, describe, expect, it } from "vitest";

import { createOfflineServer } from "../../../scripts/offline.ts";
import { sendCachedContent } from "../../../server/api/_content.ts";
import type { CachedContentFile } from "../../../server/cache/contentStore.ts";
import { browserSecurityHeaders } from "../../../server/core/securityHeaders.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function contentResponse(root: string, content: CachedContentFile | null): Promise<Response> {
  const app = createApp().use(
    defineEventHandler(async (event) => sendCachedContent(event, content, root)),
  );
  const server = createServer(toNodeListener(app));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The content-boundary fixture did not bind a TCP port.");
    }
    return await fetch(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

async function offlineResponse(root: string, pathname: string, method = "GET"): Promise<Response> {
  const server = await createOfflineServer(root);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The offline-server fixture did not bind a TCP port.");
    }
    const response = await fetch(`http://127.0.0.1:${String(address.port)}${pathname}`, {
      method,
      headers: { Connection: "close" },
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

describe("cached HTTP content authorization", () => {
  it("serves only an integrity-checked unlinked file below the authorized root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-viewer-content-boundary-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "cache");
    await mkdir(root);
    const bytes = Buffer.from("private cached content");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(root, `${sha256}.bin`);
    await writeFile(path, bytes);

    const response = await contentResponse(root, {
      path,
      mimeType: null,
      sha256,
      byteSize: bytes.byteLength,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ["missing record", null],
    ["outside path", "outside"],
    ["authorized root itself", "root"],
    ["wrong filename", "filename"],
    ["wrong hash", "hash"],
    ["wrong byte size", "size"],
    ["directory", "directory"],
    ["hard link", "hardlink"],
  ])("returns 404 for %s", async (_label, variant) => {
    const parent = await mkdtemp(join(tmpdir(), "codex-viewer-content-denied-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "cache");
    await mkdir(root);
    const bytes = Buffer.from("cached bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const validPath = join(root, `${sha256}.bin`);
    await writeFile(validPath, bytes);
    let content: CachedContentFile | null = {
      path: validPath,
      mimeType: "text/plain",
      sha256,
      byteSize: bytes.byteLength,
    };
    if (variant === null) {
      content = null;
    } else if (variant === "outside") {
      const outside = join(parent, `${sha256}.bin`);
      await writeFile(outside, bytes);
      content.path = outside;
    } else if (variant === "root") {
      content.path = root;
    } else if (variant === "filename") {
      const wrongName = join(root, "wrong.bin");
      await writeFile(wrongName, bytes);
      content.path = wrongName;
    } else if (variant === "hash") {
      content.sha256 = "0".repeat(64);
    } else if (variant === "size") {
      content.byteSize = bytes.byteLength + 1;
    } else if (variant === "directory") {
      const directory = join(root, `${sha256}.dir`);
      await mkdir(directory);
      content.path = directory;
    } else if (variant === "hardlink") {
      const linked = join(root, `${sha256}.linked`);
      await link(validPath, linked);
      content.path = linked;
    }

    const response = await contentResponse(root, content);

    expect(response.status).toBe(404);
  });
});

describe("offline browser containment", () => {
  it("applies the shared headers to HTML, scripts, styles, JSON, fonts, and media", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-offline-headers-"));
    temporaryDirectories.push(root);
    const files = [
      ["index.html", "<!doctype html><title>Offline</title>", "no-cache"],
      ["app.js", "export const ready = true;", "public, max-age=31536000, immutable"],
      ["app.css", "body { color: CanvasText; }", "public, max-age=31536000, immutable"],
      ["payload.json", '{"ready":true}', "public, max-age=31536000, immutable"],
      ["font.woff2", Buffer.from([119, 79, 70, 50]), "public, max-age=31536000, immutable"],
      ["media.mp3", Buffer.from([73, 68, 51]), "public, max-age=31536000, immutable"],
    ] as const;
    await Promise.all(files.map(([name, bytes]) => writeFile(join(root, name), bytes)));

    for (const [name, , expectedCache] of files) {
      // oxlint-disable-next-line no-await-in-loop -- Each response owns a bounded ephemeral server.
      const response = await offlineResponse(root, `/${name}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(expectedCache);
      for (const [header, value] of Object.entries(browserSecurityHeaders)) {
        expect(response.headers.get(header), `${name} ${header}`).toBe(value);
      }
    }

    const head = await offlineResponse(root, "/index.html", "HEAD");
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-security-policy")).toBe(
      browserSecurityHeaders["Content-Security-Policy"],
    );
  });
});
