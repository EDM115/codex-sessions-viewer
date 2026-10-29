import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOfflineServer } from "../../../scripts/offline.ts";
import { browserSecurityHeaders } from "../../../server/core/securityHeaders.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

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
