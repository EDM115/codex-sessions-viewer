import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { fileTypeFromBuffer } from "file-type";
import type { Root, RootContent } from "hast";
import rehypeRaw from "rehype-raw";
import { unified } from "unified";

import { fetchFaviconHttp, type FaviconHttpClient } from "#server/content/favicons.ts";
import { previewImageDimensions } from "#server/content/previewImage.ts";
import { writeOutputFile } from "#server/export/outputFiles.ts";
import {
  canonicalWebsiteUrl,
  linkPreviewSchema,
  type LinkPreview,
} from "#shared/types/linkPreview.ts";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const filename = (image: NonNullable<LinkPreview["image"]>) =>
  `${image.sha256}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice(6)}`;
const compact = (value: string | undefined, limit: number) =>
  value?.replace(/\s+/gu, " ").trim().slice(0, limit) || null;

export async function parseWebsiteMetadata(bytes: Buffer, contentType: string, finalUrl: string) {
  if (
    bytes.length > 1024 * 1024 ||
    !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(contentType)
  ) {
    throw new Error("preview.unsupported");
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(/charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1] ?? "utf-8");
  } catch {
    decoder = new TextDecoder();
  }
  const html = decoder.decode(bytes).split(/<\/head\s*>/iu)[0]!;
  const tree: Root = await unified()
    .use(rehypeRaw)
    .run({ type: "root", children: [{ type: "raw", value: html }] });
  const fields = new Map<string, string>();
  let title = "";
  const text = (node: RootContent): string =>
    node.type === "text" ? node.value : "children" in node ? node.children.map(text).join("") : "";
  function visit(node: Root | RootContent) {
    if (node.type === "element") {
      if (node.tagName === "meta") {
        const key = node.properties["property"] ?? node.properties["name"];
        const content = node.properties["content"];
        if (
          typeof key === "string" &&
          typeof content === "string" &&
          content.trim() &&
          !fields.has(key.toLowerCase())
        ) {
          fields.set(key.toLowerCase(), content);
        }
      }
      if (node.tagName === "title" && !title) {
        title = text(node);
      }
    }
    if ("children" in node) {
      node.children.forEach(visit);
    }
  }
  visit(tree);
  const image = [
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
  ]
    .map((key) => fields.get(key))
    .find(Boolean);
  let imageUrl: string | null = null;
  try {
    if (image) {
      imageUrl = canonicalWebsiteUrl(new URL(image, finalUrl).href);
    }
  } catch {
    /* Invalid imagery leaves a usable text preview */
  }
  return {
    title: compact(fields.get("og:title") ?? fields.get("twitter:title") ?? title, 300),
    description: compact(
      fields.get("og:description") ??
        fields.get("twitter:description") ??
        fields.get("description"),
      1000,
    ),
    imageUrl,
  };
}

export async function readPreviewImage(
  root: string,
  image: NonNullable<LinkPreview["image"]>,
): Promise<Buffer | null> {
  try {
    const directory = await lstat(root);
    const path = join(root, filename(image));
    const info = await lstat(path);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size !== image.byteSize ||
      info.size > 2 * 1024 * 1024
    ) {
      return null;
    }
    const bytes = await readFile(path);
    return digest(bytes) === image.sha256 ? bytes : null;
  } catch {
    return null;
  }
}

function unavailable(url: string, reason: NonNullable<LinkPreview["reason"]>): LinkPreview {
  return {
    version: 1,
    provenance: "viewer-enrichment",
    url,
    finalUrl: null,
    revision: digest(JSON.stringify([url, reason])),
    availability:
      reason === "disabled" ? "disabled" : reason === "overloaded" ? "overloaded" : "unavailable",
    title: null,
    description: null,
    image: null,
    fetchedAt: null,
    retryAt: null,
    reason,
  };
}
interface PreviewJob {
  controller: AbortController;
  promise: Promise<LinkPreview>;
  subscribers: number;
  settled: boolean;
}
export class LinkPreviewService {
  readonly database: DatabaseSync;
  readonly root: string;
  readonly options: {
    enabled: boolean;
    client?: FaviconHttpClient | undefined;
    now?: () => number;
  };
  readonly #jobs = new Map<string, PreviewJob>();
  readonly #waiting: Array<() => void> = [];
  #active = 0;
  #closed = false;
  constructor(
    database: DatabaseSync,
    root: string,
    options: { enabled: boolean; client?: FaviconHttpClient | undefined; now?: () => number },
  ) {
    this.database = database;
    this.root = root;
    this.options = options;
  }
  async cached(url: string): Promise<LinkPreview | null> {
    const row = this.database
      .prepare("SELECT payload_json FROM website_previews WHERE url = ?")
      .get(url);
    if (typeof row?.["payload_json"] !== "string") {
      return null;
    }
    try {
      const saved = linkPreviewSchema.parse(JSON.parse(row["payload_json"]));
      if (saved.url !== url) {
        return null;
      }
      return saved.image && !(await readPreviewImage(this.root, saved.image))
        ? { ...saved, image: null }
        : saved;
    } catch {
      return null;
    }
  }
  async resolve(input: string, signal?: AbortSignal): Promise<LinkPreview> {
    signal?.throwIfAborted();
    const url = canonicalWebsiteUrl(input);
    if (this.#closed) {
      throw new Error("preview.closed");
    }
    const cached = await this.cached(url);
    signal?.throwIfAborted();
    const now = this.options.now?.() ?? Date.now();
    if (cached && (!this.options.enabled || Date.parse(cached.retryAt ?? "") > now)) {
      return cached;
    }
    if (!this.options.enabled) {
      return unavailable(url, "disabled");
    }
    let job = this.#jobs.get(url);
    if (!job) {
      if (this.#jobs.size >= 12) {
        return unavailable(url, "overloaded");
      }
      const controller = new AbortController();
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
      const promise = this.#fetch(url, deadline);
      job = { controller, promise, subscribers: 0, settled: false };
      this.#jobs.set(url, job);
      const current = job;
      void promise
        .finally(() => {
          current.settled = true;
          if (this.#jobs.get(url) === current) {
            this.#jobs.delete(url);
          }
        })
        .catch(() => undefined);
    }
    const current = job;
    current.subscribers += 1;
    return new Promise((resolve, reject) => {
      let detached = false;
      const detach = () => {
        if (detached) {
          return false;
        }
        detached = true;
        signal?.removeEventListener("abort", abort);
        current.subscribers -= 1;
        if (!current.settled && current.subscribers === 0) {
          current.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (detach()) {
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      current.promise.then(
        (result) => {
          if (detach()) {
            resolve(result);
          }
          return undefined;
        },
        (error: unknown) => {
          if (detach()) {
            reject(error);
          }
        },
      );
    });
  }
  async #acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#active < 4) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abort);
        this.#active += 1;
        resolve();
      };
      const abort = () => {
        const index = this.#waiting.indexOf(ready);
        if (index >= 0) {
          this.#waiting.splice(index, 1);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiting.push(ready);
    });
  }
  async #fetch(url: string, signal: AbortSignal): Promise<LinkPreview> {
    await this.#acquire(signal);
    try {
      const client = this.options.client ?? fetchFaviconHttp;
      const validateUrl = (target: URL) => {
        canonicalWebsiteUrl(target.href);
      };
      const response = await client(new URL(url), {
        maxBytes: 1024 * 1024,
        accept: "text/html,application/xhtml+xml",
        signal,
        validateUrl,
      });
      signal.throwIfAborted();
      const finalUrl = canonicalWebsiteUrl(response.url.href);
      if (response.status < 200 || response.status >= 300) {
        throw new Error("preview.unavailable");
      }
      const metadata = await parseWebsiteMetadata(
        response.body,
        response.contentType ?? "",
        finalUrl,
      );
      let image: LinkPreview["image"] = null;
      if (metadata.imageUrl) {
        try {
          const responseImage = await client(new URL(metadata.imageUrl), {
            maxBytes: 2 * 1024 * 1024,
            accept: "image/png,image/jpeg,image/gif,image/webp",
            signal,
            validateUrl,
          });
          signal.throwIfAborted();
          canonicalWebsiteUrl(responseImage.url.href);
          const type = await fileTypeFromBuffer(responseImage.body);
          const dimensions = type ? previewImageDimensions(responseImage.body, type.mime) : null;
          if (
            responseImage.status >= 200 &&
            responseImage.status < 300 &&
            responseImage.body.length <= 2 * 1024 * 1024 &&
            type &&
            dimensions
          ) {
            const sha256 = digest(responseImage.body);
            const extension = type.mime === "image/jpeg" ? "jpg" : type.mime.slice(6);
            image = linkPreviewSchema.shape.image.unwrap().parse({
              url: `/api/link-preview-images/${sha256}.${extension}`,
              sourceUrl: responseImage.url.href,
              sha256,
              mimeType: type.mime,
              byteSize: responseImage.body.length,
              ...dimensions,
            });
            await writeOutputFile(this.root, [filename(image)], responseImage.body);
          }
        } catch {
          signal.throwIfAborted();
        }
      }
      signal.throwIfAborted();
      const now = this.options.now?.() ?? Date.now();
      const result: LinkPreview = {
        ...unavailable(url, "unavailable"),
        finalUrl,
        title: metadata.title,
        description: metadata.description,
        image,
        availability: metadata.title || metadata.description || image ? "ready" : "unavailable",
        reason: metadata.title || metadata.description || image ? null : "unavailable",
        fetchedAt: new Date(now).toISOString(),
        retryAt: new Date(now + (image ? 600000 : 30000)).toISOString(),
      };
      result.revision = digest(JSON.stringify(result));
      this.#save(result, now);
      await this.#prune();
      return result;
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const now = this.options.now?.() ?? Date.now();
      const result = {
        ...unavailable(url, "unavailable"),
        fetchedAt: new Date(now).toISOString(),
        retryAt: new Date(now + 30000).toISOString(),
      };
      this.#save(result, now);
      return result;
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
  #save(result: LinkPreview, now: number) {
    if (!this.#closed) {
      this.database
        .prepare(
          "INSERT INTO website_previews(url,payload_json,fetched_at) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET payload_json=excluded.payload_json,fetched_at=excluded.fetched_at",
        )
        .run(result.url, JSON.stringify(result), now);
    }
  }
  async #prune() {
    const expired = this.database
      .prepare(
        "SELECT url,payload_json FROM website_previews ORDER BY fetched_at DESC,url LIMIT -1 OFFSET 128",
      )
      .all();
    for (const row of expired) {
      const saved = linkPreviewSchema.safeParse(JSON.parse(String(row["payload_json"])));
      this.database.prepare("DELETE FROM website_previews WHERE url = ?").run(String(row["url"]));
      if (
        saved.success &&
        saved.data.image &&
        !this.database
          .prepare(
            "SELECT 1 FROM website_previews WHERE json_extract(payload_json,'$.image.sha256')=? LIMIT 1",
          )
          .get(saved.data.image.sha256)
      ) {
        // oxlint-disable-next-line no-await-in-loop -- Only an unreferenced content-addressed image in the viewer preview root is removed
        await rm(join(this.root, filename(saved.data.image)), { force: true });
      }
    }
  }
  async close() {
    this.#closed = true;
    for (const job of this.#jobs.values()) {
      job.controller.abort();
    }
    await Promise.allSettled([...this.#jobs.values()].map(({ promise }) => promise));
  }
}
