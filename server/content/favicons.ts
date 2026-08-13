import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { fileTypeFromBuffer } from "file-type";
import type { Properties, Root, RootContent } from "hast";
import rehypeRaw from "rehype-raw";
import { unified } from "unified";

import { sanitizeSvg } from "./sanitizeSvg.ts";

const MAX_HTML_BYTES = 512 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const DEFAULT_FAILURE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TOTAL_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_REDIRECT_LIMIT = 3;
const MAX_DECLARED_ICONS = 16;

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

export interface FaviconHttpResponse {
  url: URL;
  status: number;
  contentType: string | null;
  body: Buffer;
  location?: string | null | undefined;
}

export interface FaviconHttpOptions {
  maxBytes: number;
  accept: string;
}

export type FaviconHttpClient = (
  url: URL,
  options: FaviconHttpOptions,
) => Promise<FaviconHttpResponse>;

export interface RemoteLookupAddress {
  address: string;
  family: 4 | 6;
}

export interface AssertSafeRemoteUrlOptions {
  lookup?: ((hostname: string) => Promise<RemoteLookupAddress[]>) | undefined;
}

export type FaviconSource = "google" | "duckduckgo" | "yandex" | "favicon-im" | "origin";

export interface FaviconFallbackTile {
  label: string;
  background: string;
}

export interface FaviconResolution {
  origin: string;
  status: "available" | "fallback";
  pending: boolean;
  source: FaviconSource | null;
  sourceUrl: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  cachePath: string | null;
  fallback: FaviconFallbackTile;
  backgroundRefresh: Promise<FaviconResolution> | null;
}

export interface ResolveFaviconOptions {
  mode: "export" | "live";
  faviconRoot: string;
  offline?: boolean | undefined;
  client?: FaviconHttpClient | undefined;
  failureTtlMs?: number | undefined;
}

interface ValidatedImage {
  bytes: Buffer;
  mimeType: string;
  extension: string;
  sha256: string;
}

interface FaviconCandidate extends ValidatedImage {
  source: FaviconSource;
  sourceUrl: string;
}

interface CachedFavicon {
  origin: string;
  url: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  cachePath: string | null;
  status: "available" | "missing" | "error";
  fetchedAt: string | null;
}

const backgroundRefreshes = new WeakMap<DatabaseSync, Map<string, Promise<FaviconResolution>>>();
const providerPlaceholders = new WeakMap<
  FaviconHttpClient,
  Map<FaviconSource, Promise<ValidatedImage | null>>
>();

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Favicon URLs must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Favicon URLs must not contain credentials.");
  }
  if (isIP(hostnameWithoutBrackets(url.hostname)) !== 0) {
    throw new Error("Favicon URLs must not use an IP literal.");
  }
}

export function canonicalFaviconOrigin(input: string): string {
  const url = new URL(input);
  assertHttpUrl(url);
  return url.origin;
}

function isBlockedAddress(address: RemoteLookupAddress): boolean {
  return address.family === 4
    ? blockedIpv4.check(address.address, "ipv4")
    : blockedIpv6.check(address.address, "ipv6");
}

async function systemLookup(hostname: string): Promise<RemoteLookupAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, order: "verbatim" });
  return addresses
    .filter(
      (address): address is RemoteLookupAddress => address.family === 4 || address.family === 6,
    )
    .map(({ address, family }) => ({ address, family }));
}

export async function assertSafeRemoteUrl(
  url: URL,
  options: AssertSafeRemoteUrlOptions = {},
): Promise<RemoteLookupAddress> {
  assertHttpUrl(url);
  const addresses = await (options.lookup ?? systemLookup)(url.hostname);
  if (addresses.length === 0) {
    throw new Error("The favicon hostname did not resolve.");
  }
  if (addresses.some(isBlockedAddress)) {
    throw new Error("The favicon hostname resolved to a non-public address.");
  }
  return addresses[0]!;
}

async function requestOnce(
  url: URL,
  pinned: RemoteLookupAddress,
  options: FaviconHttpOptions,
  signal: AbortSignal,
): Promise<FaviconHttpResponse> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const message = request(
      url,
      {
        agent: false,
        headers: {
          accept: options.accept,
          "accept-encoding": "identity",
          "user-agent": "codex-sessions-viewer/0.1 (+local favicon cache)",
        },
        lookup: (_hostname, _lookupOptions, callback) => {
          callback(null, pinned.address, pinned.family);
        },
        maxHeaderSize: 16 * 1024,
        method: "GET",
        signal,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const declaredLength = Number(incoming.headers["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
          incoming.destroy(new Error("The favicon response exceeded its byte limit."));
          return;
        }
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > options.maxBytes) {
            incoming.destroy(new Error("The favicon response exceeded its byte limit."));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        incoming.on("end", () => {
          resolve({
            url,
            status: incoming.statusCode ?? 0,
            contentType: Array.isArray(incoming.headers["content-type"])
              ? (incoming.headers["content-type"][0] ?? null)
              : (incoming.headers["content-type"] ?? null),
            body: Buffer.concat(chunks),
            location: Array.isArray(incoming.headers.location)
              ? (incoming.headers.location[0] ?? null)
              : (incoming.headers.location ?? null),
          });
        });
        incoming.on("error", reject);
      },
    );
    message.setTimeout(DEFAULT_CONNECT_TIMEOUT_MS, () => {
      message.destroy(new Error("The favicon connection timed out."));
    });
    message.on("error", reject);
    message.end();
  });
}

export const fetchFaviconHttp: FaviconHttpClient = async (initialUrl, options) => {
  let url = initialUrl;
  const signal = AbortSignal.timeout(DEFAULT_TOTAL_TIMEOUT_MS);
  for (let redirects = 0; redirects <= DEFAULT_REDIRECT_LIMIT; redirects += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Every redirect target must be resolved and pinned independently.
    const pinned = await assertSafeRemoteUrl(url);
    // oxlint-disable-next-line no-await-in-loop -- Redirect handling is deliberately sequential and bounded.
    const response = await requestOnce(url, pinned, options, signal);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    if (response.location === null || response.location === undefined) {
      return response;
    }
    url = new URL(response.location, url);
  }
  throw new Error("The favicon request exceeded its redirect limit.");
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function validateImage(response: FaviconHttpResponse): Promise<ValidatedImage | null> {
  if (response.status < 200 || response.status >= 300 || response.body.byteLength === 0) {
    return null;
  }
  const prefix = response.body.subarray(0, 512).toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(prefix)) {
    const sanitized = await sanitizeSvg(response.body.toString("utf8"));
    if (sanitized === null) {
      return null;
    }
    const bytes = Buffer.from(sanitized);
    return { bytes, mimeType: "image/svg+xml", extension: "svg", sha256: sha256(bytes) };
  }
  const detected = await fileTypeFromBuffer(response.body);
  if (
    detected === undefined ||
    !new Set([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/x-icon",
      "image/bmp",
    ]).has(detected.mime)
  ) {
    return null;
  }
  return {
    bytes: response.body,
    mimeType: detected.mime,
    extension: detected.ext,
    sha256: sha256(response.body),
  };
}

interface Provider {
  source: Exclude<FaviconSource, "origin">;
  target(hostname: string): URL;
}

const providers: readonly Provider[] = [
  {
    source: "google",
    target: (hostname) =>
      new URL(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`),
  },
  {
    source: "duckduckgo",
    target: (hostname) =>
      new URL(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`),
  },
  {
    source: "yandex",
    target: (hostname) =>
      new URL(`https://favicon.yandex.net/favicon/${encodeURIComponent(hostname)}`),
  },
  {
    source: "favicon-im",
    target: (hostname) =>
      new URL(`https://a.favicon.im/${encodeURIComponent(hostname)}?larger=true`),
  },
];

function invalidProviderHostname(source: FaviconSource): string {
  return `missing-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.invalid`;
}

async function providerPlaceholder(
  provider: Provider,
  client: FaviconHttpClient,
): Promise<ValidatedImage | null> {
  let cache = providerPlaceholders.get(client);
  if (cache === undefined) {
    cache = new Map();
    providerPlaceholders.set(client, cache);
  }
  let pending = cache.get(provider.source);
  if (pending === undefined) {
    pending = client(provider.target(invalidProviderHostname(provider.source)), {
      maxBytes: MAX_ICON_BYTES,
      accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.1",
    })
      .then(validateImage)
      .catch(() => null);
    cache.set(provider.source, pending);
  }
  return pending;
}

async function fromProviders(
  origin: URL,
  client: FaviconHttpClient,
): Promise<FaviconCandidate | null> {
  for (const provider of providers) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Providers are an ordered fallback cascade.
      const response = await client(provider.target(origin.hostname), {
        maxBytes: MAX_ICON_BYTES,
        accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.1",
      });
      // oxlint-disable-next-line no-await-in-loop -- Each untrusted image must be validated before fallback decisions.
      const image = await validateImage(response);
      if (image === null) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Placeholder comparison is provider-specific and cached.
      const placeholder = await providerPlaceholder(provider, client);
      if (placeholder !== null && placeholder.sha256 === image.sha256) {
        continue;
      }
      return { ...image, source: provider.source, sourceUrl: response.url.href };
    } catch {
      continue;
    }
  }
  return null;
}

function stringProperty(properties: Properties | undefined, key: string): string | null {
  const value = properties?.[key];
  return typeof value === "string" ? value : null;
}

function relTokens(properties: Properties | undefined): string[] {
  const value: unknown = properties?.["rel"];
  if (Array.isArray(value)) {
    return value
      .filter((token): token is string => typeof token === "string")
      .map((token) => token.toLowerCase());
  }
  return typeof value === "string" ? value.toLowerCase().split(/\s+/u) : [];
}

async function declaredIconUrls(html: string, origin: URL): Promise<URL[]> {
  const processor = unified().use(rehypeRaw);
  const tree: Root = await processor.run({
    type: "root",
    children: [{ type: "raw", value: html }],
  });
  const icons: URL[] = [];
  const visit = (node: Root | RootContent): void => {
    if (icons.length >= MAX_DECLARED_ICONS) {
      return;
    }
    if (node.type === "element" && node.tagName === "link") {
      const rel = relTokens(node.properties);
      const href = stringProperty(node.properties, "href");
      if (
        href !== null &&
        (rel.includes("icon") ||
          rel.includes("apple-touch-icon") ||
          rel.includes("apple-touch-icon-precomposed"))
      ) {
        try {
          const url = new URL(href, origin);
          assertHttpUrl(url);
          icons.push(url);
        } catch {
          // Invalid declared icons are ignored in favor of the next candidate.
        }
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(tree);
  return icons;
}

async function fromOrigin(
  origin: URL,
  client: FaviconHttpClient,
): Promise<FaviconCandidate | null> {
  let icons: URL[] = [];
  try {
    const homepage = await client(new URL("/", origin), {
      maxBytes: MAX_HTML_BYTES,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    });
    if (
      homepage.status >= 200 &&
      homepage.status < 300 &&
      homepage.contentType?.toLowerCase().includes("text/html")
    ) {
      icons = await declaredIconUrls(homepage.body.toString("utf8"), origin);
    }
  } catch {
    // Root favicon remains the final live-origin candidate.
  }
  icons.push(new URL("/favicon.ico", origin));
  const seen = new Set<string>();
  for (const icon of icons) {
    if (seen.has(icon.href)) {
      continue;
    }
    seen.add(icon.href);
    try {
      // oxlint-disable-next-line no-await-in-loop -- Declared icons are an ordered fallback cascade.
      const response = await client(icon, {
        maxBytes: MAX_ICON_BYTES,
        accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.1",
      });
      // oxlint-disable-next-line no-await-in-loop -- Each untrusted image is independently sniffed and sanitized.
      const image = await validateImage(response);
      if (image !== null) {
        return { ...image, source: "origin", sourceUrl: response.url.href };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function textOrNull(value: SQLOutputValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: SQLOutputValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function cachedFavicon(database: DatabaseSync, origin: string): CachedFavicon | null {
  const row = database.prepare("SELECT * FROM favicons WHERE origin = ?").get(origin);
  if (row === undefined) {
    return null;
  }
  const status = textOrNull(row["status"]);
  if (status !== "available" && status !== "missing" && status !== "error") {
    return null;
  }
  return {
    origin,
    url: textOrNull(row["url"]),
    mimeType: textOrNull(row["mime_type"]),
    byteSize: numberOrNull(row["byte_size"]),
    sha256: textOrNull(row["sha256"]),
    cachePath: textOrNull(row["cache_path"]),
    status,
    fetchedAt: textOrNull(row["fetched_at"]),
  };
}

function storeFavicon(database: DatabaseSync, cached: CachedFavicon, error: string | null): void {
  database
    .prepare(`
    INSERT INTO favicons (origin, url, mime_type, byte_size, sha256, cache_path, status, fetched_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin) DO UPDATE SET
      url = excluded.url,
      mime_type = excluded.mime_type,
      byte_size = excluded.byte_size,
      sha256 = excluded.sha256,
      cache_path = excluded.cache_path,
      status = excluded.status,
      fetched_at = excluded.fetched_at,
      error = excluded.error
  `)
    .run(
      cached.origin,
      cached.url,
      cached.mimeType,
      cached.byteSize,
      cached.sha256,
      cached.cachePath,
      cached.status,
      cached.fetchedAt,
      error,
    );
}

function fallbackTile(origin: string): FaviconFallbackTile {
  const hostname = new URL(origin).hostname;
  const label = hostname.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
  const color = createHash("sha256").update(hostname).digest("hex").slice(0, 6);
  return { label, background: `#${color}` };
}

function fallbackResolution(
  origin: string,
  backgroundRefresh: Promise<FaviconResolution> | null,
): FaviconResolution {
  return {
    origin,
    status: "fallback",
    pending: backgroundRefresh !== null,
    source: null,
    sourceUrl: null,
    mimeType: null,
    byteSize: null,
    sha256: null,
    cachePath: null,
    fallback: fallbackTile(origin),
    backgroundRefresh,
  };
}

function availableResolution(
  origin: string,
  cached: CachedFavicon,
  source: FaviconSource | null,
): FaviconResolution {
  return {
    origin,
    status: "available",
    pending: false,
    source,
    sourceUrl: cached.url,
    mimeType: cached.mimeType,
    byteSize: cached.byteSize,
    sha256: cached.sha256,
    cachePath: cached.cachePath,
    fallback: fallbackTile(origin),
    backgroundRefresh: null,
  };
}

async function cacheFileValid(cached: CachedFavicon): Promise<boolean> {
  if (cached.status !== "available" || cached.cachePath === null || cached.sha256 === null) {
    return false;
  }
  return faviconFileValid(cached.cachePath, cached.sha256);
}

async function faviconFileValid(path: string, expectedHash: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1 &&
      sha256(await readFile(path)) === expectedHash
    );
  } catch {
    return false;
  }
}

async function writeFaviconFile(root: string, image: ValidatedImage): Promise<string> {
  await mkdir(root, { recursive: true });
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The favicon cache root must be an unlinked directory.");
  }
  const destination = join(root, `${image.sha256}.${image.extension}`);
  if (await faviconFileValid(destination, image.sha256)) {
    return destination;
  }
  const temporary = join(root, `.${image.sha256}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, image.bytes, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!(await faviconFileValid(destination, image.sha256))) {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  if (!(await faviconFileValid(destination, image.sha256))) {
    throw new Error("The content-addressed favicon file failed its integrity check.");
  }
  return destination;
}

async function refreshFavicon(
  database: DatabaseSync,
  origin: string,
  options: ResolveFaviconOptions,
): Promise<FaviconResolution> {
  const originUrl = new URL(origin);
  const client = options.client ?? fetchFaviconHttp;
  const candidate =
    (await fromProviders(originUrl, client)) ?? (await fromOrigin(originUrl, client));
  const fetchedAt = new Date().toISOString();
  if (candidate === null) {
    storeFavicon(
      database,
      {
        origin,
        url: null,
        mimeType: null,
        byteSize: null,
        sha256: null,
        cachePath: null,
        status: "missing",
        fetchedAt,
      },
      "No valid favicon provider or live-origin candidate succeeded.",
    );
    return fallbackResolution(origin, null);
  }
  const cachePath = await writeFaviconFile(options.faviconRoot, candidate);
  const cached: CachedFavicon = {
    origin,
    url: candidate.sourceUrl,
    mimeType: candidate.mimeType,
    byteSize: candidate.bytes.byteLength,
    sha256: candidate.sha256,
    cachePath,
    status: "available",
    fetchedAt,
  };
  storeFavicon(database, cached, null);
  return availableResolution(origin, cached, candidate.source);
}

function failureFresh(cached: CachedFavicon, ttl: number): boolean {
  const fetched = cached.fetchedAt === null ? Number.NaN : Date.parse(cached.fetchedAt);
  return cached.status !== "available" && Number.isFinite(fetched) && Date.now() - fetched < ttl;
}

export async function resolveFavicon(
  database: DatabaseSync,
  input: string,
  options: ResolveFaviconOptions,
): Promise<FaviconResolution> {
  const origin = canonicalFaviconOrigin(input);
  const cached = cachedFavicon(database, origin);
  if (cached !== null && (await cacheFileValid(cached))) {
    return availableResolution(origin, cached, null);
  }
  if (
    options.offline ||
    (cached !== null && failureFresh(cached, options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS))
  ) {
    return fallbackResolution(origin, null);
  }
  if (options.mode === "export") {
    return refreshFavicon(database, origin, options);
  }
  let refreshes = backgroundRefreshes.get(database);
  if (refreshes === undefined) {
    refreshes = new Map();
    backgroundRefreshes.set(database, refreshes);
  }
  let background = refreshes.get(origin);
  if (background === undefined) {
    const activeRefreshes = refreshes;
    background = refreshFavicon(database, origin, options).finally(() => {
      activeRefreshes.delete(origin);
    });
    refreshes.set(origin, background);
  }
  return fallbackResolution(origin, background);
}
