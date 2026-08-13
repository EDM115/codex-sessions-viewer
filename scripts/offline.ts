import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const HELP = `Codex Sessions Viewer offline server

Usage: pnpm offline [options]

Options:
  -p, --port <number>  Listen on this loopback port (default: ${DEFAULT_PORT})
  --help               Show this help and exit`;

const contentTypes: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

function parsePort(args: readonly string[]): number {
  let port = DEFAULT_PORT;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const inlineValue = argument?.startsWith("--port=")
      ? argument.slice("--port=".length)
      : undefined;

    if (argument === "--port" || argument === "-p") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }

      port = parsePortValue(value);
      index += 1;
      continue;
    }

    if (inlineValue !== undefined) {
      port = parsePortValue(inlineValue);
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return port;
}

function parsePortValue(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function findFile(root: string, pathname: string): Promise<string | null> {
  const relativePath = pathname.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath || "index.html");

  if (!isWithinRoot(root, candidate)) {
    return null;
  }

  const candidates = pathname.endsWith("/")
    ? [resolve(root, relativePath, "index.html")]
    : [candidate, resolve(candidate, "index.html")];

  for (const path of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Static-route candidates must retain fallback priority.
      const fileStats = await stat(path);
      const filePath = fileStats.isDirectory() ? resolve(path, "index.html") : path;
      // oxlint-disable-next-line no-await-in-loop -- Resolve only the first candidate that exists.
      const resolvedPath = await realpath(filePath);
      // oxlint-disable-next-line no-await-in-loop -- Validate the selected candidate before trying the fallback.
      const resolvedStats = await stat(resolvedPath);

      if (resolvedStats.isFile() && isWithinRoot(root, resolvedPath)) {
        return resolvedPath;
      }
    } catch {
      // Try the next static-route candidate.
    }
  }

  return null;
}

async function sendFile(
  response: ServerResponse,
  filePath: string,
  method: string,
  statusCode = 200,
): Promise<void> {
  const fileStats = await stat(filePath);
  const contentType = contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";

  response.writeHead(statusCode, {
    "Cache-Control": filePath.endsWith(".html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "Content-Length": fileStats.size,
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  await pipeline(createReadStream(filePath), response);
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments.includes("--help")) {
    console.log(HELP);
    return;
  }

  const port = parsePort(rawArguments);
  const outputDirectory = resolve(process.cwd(), ".output/public");
  let root: string;

  try {
    root = await realpath(outputDirectory);
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error(`Static output not found at ${outputDirectory}. Run pnpm export first.`);
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end("Method not allowed");
        return;
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://offline.local").pathname);
      } catch {
        response.writeHead(400);
        response.end("Bad request");
        return;
      }

      const filePath = await findFile(root, pathname);
      if (filePath !== null) {
        await sendFile(response, filePath, request.method);
        return;
      }

      const notFoundPath = await findFile(root, "/404.html");
      if (notFoundPath !== null) {
        await sendFile(response, notFoundPath, request.method, 404);
        return;
      }

      response.writeHead(404);
      response.end("Not found");
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end("Internal server error");
      console.error(error);
    });
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    const handleListenError = (error: Error): void => {
      rejectListening(error);
    };

    server.once("error", handleListenError);
    server.listen(port, HOST, () => {
      server.off("error", handleListenError);
      resolveListening();
    });
  });

  console.log(`Codex Sessions Viewer offline: http://${HOST}:${port}`);

  const close = (): void => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
