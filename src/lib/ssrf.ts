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

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Resolve the canonical origin a target actually serves from by following its
 * redirects (e.g. apex `https://tradogram.com` → `https://www.tradogram.com`).
 *
 * The proxy only rewrites *same-origin* redirects, so if the stored target
 * origin permanently redirects to a sibling host (apex↔www), the framed iframe
 * would be sent to the un-proxied real site and break. Storing the post-redirect
 * origin instead means the proxy always fetches a host that doesn't redirect away.
 *
 * Every hop is re-validated with {@link validateProxyTarget}; a redirect into
 * unsafe space (private/loopback) is refused and the last safe origin is kept.
 * On any network/timeout error it falls back to the input origin — never worse
 * than today's behaviour.
 */
export async function resolveCanonicalTarget(
  rawUrl: string,
  opts: { maxHops?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProxyTargetResult> {
  const initial = validateProxyTarget(rawUrl);
  if (!initial.ok) return initial;

  const maxHops = opts.maxHops ?? 5;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const doFetch = opts.fetchImpl ?? fetch;

  let origin = initial.origin;
  let nextUrl = `${origin}/`;

  for (let i = 0; i < maxHops; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(nextUrl, {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": BROWSER_UA },
      });
    } catch {
      return { ok: true, origin }; // unreachable/timeout — keep best-known origin
    } finally {
      clearTimeout(timer);
    }

    if (res.status < 300 || res.status >= 400) return { ok: true, origin };
    const loc = res.headers.get("location");
    if (!loc) return { ok: true, origin };

    let abs: URL;
    try {
      abs = new URL(loc, nextUrl);
    } catch {
      return { ok: true, origin };
    }
    const checked = validateProxyTarget(abs.toString());
    if (!checked.ok) return { ok: true, origin }; // don't follow into unsafe space
    if (abs.origin === origin) return { ok: true, origin }; // same-origin (e.g. /→/en) — host is canonical
    origin = abs.origin;
    nextUrl = abs.toString();
  }
  return { ok: true, origin };
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
