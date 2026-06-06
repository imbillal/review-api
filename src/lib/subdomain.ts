import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomLabel(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** Opaque DNS-safe label, e.g. "d-ab12cd34". Used as the fallback when a host
 *  yields no usable base and as the last resort for the uniqueness loop. */
export function generateSubdomain(): string {
  return `d-${randomLabel(8)}`;
}

// Cap the readable base so base + "-xxxx" suffix stays within the 63-char DNS
// label limit.
const MAX_BASE_LEN = 50;

/**
 * Derive a human-readable, DNS-safe subdomain label from a target URL/origin:
 *   https://www.dorik.com  -> "dorik-com"
 *   https://app.billal.dev -> "app-billal-dev"
 *   https://billal.dev     -> "billal-dev"
 * Strips a leading "www.", flattens the host to a single [a-z0-9-] label, and
 * falls back to a random `d-xxxx` label when the host yields nothing usable
 * (bare IPs that reduce to empty, all-symbol hosts, unparseable input).
 */
export function deriveSubdomainBase(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return generateSubdomain();
  }
  const base = host
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-") // dots and any other char -> hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, MAX_BASE_LEN)
    .replace(/-+$/g, ""); // re-trim if the slice left a trailing hyphen
  return base || generateSubdomain();
}

/** Append a short random suffix to a base label: "billal-dev" -> "billal-dev-a3f9". */
export function suffixSubdomain(base: string): string {
  return `${base}-${randomLabel(4)}`;
}

/**
 * Persist a record under a unique subdomain, deriving the first attempt from the
 * readable base and retrying with a random suffix when it collides.
 *
 * `create` performs the insert with the given subdomain and must throw when the
 * subdomain is already taken; `isTaken` identifies that error (a unique-index
 * violation). The candidate sequence is: the clean base, two suffixed variants,
 * then a fully random `d-xxxx` (collision-free in practice). Returns the
 * subdomain that was actually stored.
 */
export async function createWithUniqueSubdomain(
  base: string,
  create: (subdomain: string) => Promise<void>,
  isTaken: (e: unknown) => boolean,
): Promise<string> {
  const candidates = [base, suffixSubdomain(base), suffixSubdomain(base), generateSubdomain()];
  let lastErr: unknown;
  for (const subdomain of candidates) {
    try {
      await create(subdomain);
      return subdomain;
    } catch (e) {
      if (!isTaken(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
