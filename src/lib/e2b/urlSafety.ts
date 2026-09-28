import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { DaytonaInputError } from "../daytona/errors.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

function ipv4IsPrivate(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
}

function ipv6IsPrivate(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return Boolean(mapped && ipv4IsPrivate(mapped[1]));
}

export function isPrivateAddress(value: string): boolean {
  const kind = isIP(value);
  return kind === 4 ? ipv4IsPrivate(value) : kind === 6 ? ipv6IsPrivate(value) : true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return !host || BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local");
}

export async function assertSafeBrowserUrl(value: unknown, options: { resolveDns?: boolean } = {}): Promise<URL> {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_000) throw new DaytonaInputError("Browser URL must be 1-2000 characters");
  let url: URL;
  try { url = new URL(value); } catch { throw new DaytonaInputError("Browser URL must be a valid http(s) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port === "0") throw new DaytonaInputError("Browser URL must use http(s) without embedded credentials");
  const hostname = url.hostname.toLowerCase();
  if (isBlockedHostname(hostname) || (isIP(hostname) !== 0 && isPrivateAddress(hostname))) throw new DaytonaInputError("Browser navigation to private or local network addresses is blocked");
  if (options.resolveDns !== false && isIP(hostname) === 0) {
    let addresses: Array<{ address: string }>;
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new DaytonaInputError("Browser hostname could not be resolved safely"); }
    if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new DaytonaInputError("Browser navigation resolved to a private or local network address");
  }
  return url;
}
