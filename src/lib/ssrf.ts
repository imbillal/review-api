export type ProxyTargetResult =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // malformed → treat unsafe
  if (a === 0 || a === 127) return true;                 // this-host / loopback
  if (a === 10) return true;                             // 10/8
  if (a === 192 && b === 168) return true;               // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12
  if (a === 169 && b === 254) return true;               // link-local + metadata
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;            // loopback / unspecified
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;         // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;         // fe80::/10 link-local
  return false;
}

/** Validate a URL submitted as a proxy target. Name- and literal-IP-based. */
export function validateProxyTarget(rawUrl: string): ProxyTargetResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http and https are allowed" };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "Missing host" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "Loopback host not allowed" };
  }
  if (host.endsWith(".local")) {
    return { ok: false, reason: "mDNS host not allowed" };
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    return { ok: false, reason: "Private or link-local address not allowed" };
  }
  return { ok: true, origin: url.origin };
}
