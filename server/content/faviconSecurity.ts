import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

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

export interface RemoteLookupAddress {
  address: string;
  family: 4 | 6;
}

export interface AssertSafeRemoteUrlOptions {
  lookup?: ((hostname: string) => Promise<RemoteLookupAddress[]>) | undefined;
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function assertHttpUrl(url: URL): void {
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
