import { createError, defineEventHandler, getRequestHost } from "h3";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const ipv4 = normalized.split(".").map(Number);
  return (
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    ipv4[0] === 127
  );
}

export default defineEventHandler((event) => {
  let hostname: string;
  try {
    hostname = new URL(`http://${getRequestHost(event, { xForwardedHost: false })}`).hostname;
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid Host header" });
  }
  if (!isLoopbackHostname(hostname)) {
    throw createError({ statusCode: 421, statusMessage: "Loopback access only" });
  }
});
