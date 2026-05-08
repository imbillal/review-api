import { Router, type Request, type Response } from "express";
import express from "express";
import { sendError, asyncHandler } from "@/lib/api";

/**
 * Public, no-auth asset proxy. Mounted at `/asset-proxy`.
 *
 *   GET /asset-proxy?url=<absolute-upstream-url>
 *
 * Used by the /dom render pipeline so subresources (<link>/<script>/<img>/
 * fonts/etc.) load same-origin to the iframe instead of cross-origin to the
 * upstream. This bypasses CORS blocks on assets the upstream serves without
 * Access-Control-Allow-Origin (very common — Vite/Webpack output uses
 * crossorigin="" attributes that force CORS-mode fetches), as well as
 * Vercel-Firewall / hotlink protections.
 *
 * Public because /dom is public; if you later gate /dom behind auth, gate
 * this one the same way.
 *
 * SSRF: private hosts blocked, 15s timeout, 25 MB cap.
 *
 * For text/css responses we recursively rewrite `url(...)` and @import refs
 * so background-images / fonts / nested CSS imports also flow through here.
 */
const router: Router = Router();

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

function isPrivateHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local")
  );
}

// Root-relative path so the rewritten CSS stays portable across hostnames.
// Browser resolves it against the CSS's URL — which is `<self>/asset-proxy?…`
// — so it always lands back on this server.
const ASSET_PROXY_PATH = "/asset-proxy?url=";

function rewriteCssUrls(css: string, baseUrl: URL): string {
  const out = css.replace(
    /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g,
    (match, quote: string, raw: string) => {
      if (
        raw.startsWith("data:") ||
        raw.startsWith("blob:") ||
        raw.startsWith("#") ||
        raw.startsWith("about:")
      ) {
        return match;
      }
      try {
        const abs = new URL(raw, baseUrl);
        if (abs.protocol !== "http:" && abs.protocol !== "https:") return match;
        return `url(${quote}${ASSET_PROXY_PATH}${encodeURIComponent(abs.toString())}${quote})`;
      } catch {
        return match;
      }
    },
  );
  return out.replace(
    /@import\s+(['"])([^'"]+)\1/g,
    (match, quote: string, raw: string) => {
      try {
        const abs = new URL(raw, baseUrl);
        if (abs.protocol !== "http:" && abs.protocol !== "https:") return match;
        return `@import ${quote}${ASSET_PROXY_PATH}${encodeURIComponent(abs.toString())}${quote}`;
      } catch {
        return match;
      }
    },
  );
}

// Headers we MUST drop when forwarding to the upstream (hop-by-hop, identity,
// or things that would break the request if echoed). Everything else (Accept,
// Content-Type, etc.) we forward so POST/PUT/etc. work like the SPA expects.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "content-length",
  // Ours, not the upstream's:
  "origin",
  "referer",
  "cookie",
]);

// Capture body as a raw Buffer for non-GET/HEAD methods. `type: "*/*"` so
// JSON, form-urlencoded, multipart, octet-stream all flow through unchanged.
const captureRawBody = express.raw({ type: "*/*", limit: "25mb" });

router.all(
  "/",
  captureRawBody,
  asyncHandler(async (req: Request, res: Response) => {
    const target = typeof req.query.url === "string" ? req.query.url : "";
    if (!target) return sendError(res, "URL_REQUIRED", "url required", 400);

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return sendError(res, "INVALID_URL", "Invalid url", 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return sendError(res, "INVALID_URL", "Only http(s) allowed", 400);
    }
    if (isPrivateHost(parsed.hostname)) {
      return sendError(res, "SSRF_BLOCKED", "Private host not allowed", 403);
    }

    // Build forwarded request headers from the incoming request.
    const fwdHeaders: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      Accept: "*/*",
      // Pretend the request came from the upstream's own page so hotlink
      // / firewall heuristics don't flag it.
      Referer: `${parsed.protocol}//${parsed.host}/`,
    };
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== "string") continue;
      if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
      fwdHeaders[k] = v;
    }

    const method = (req.method || "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    // app.ts mounts `express.json()` globally, so JSON bodies are already
    // parsed by the time we get here (req.body is an object, not a Buffer).
    // express.raw() on this route handles other content-types as Buffers.
    // Serialize each shape back to bytes for the upstream.
    let body: Uint8Array | undefined;
    if (hasBody && req.body != null) {
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      } else if (typeof req.body === "string" && req.body.length > 0) {
        body = new TextEncoder().encode(req.body);
      } else if (typeof req.body === "object" && Object.keys(req.body).length > 0) {
        // express.json populated this — re-stringify and ensure CT is JSON.
        body = new TextEncoder().encode(JSON.stringify(req.body));
        if (!fwdHeaders["content-type"] && !fwdHeaders["Content-Type"]) {
          fwdHeaders["Content-Type"] = "application/json";
        }
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(parsed.toString(), {
        method,
        // Cast: runtime accepts Uint8Array, but the TS lib's BodyInit in this
        // project doesn't enumerate it.
        body: body as BodyInit | undefined,
        signal: ctrl.signal,
        redirect: "follow",
        headers: fwdHeaders,
      });
    } catch (e) {
      clearTimeout(timer);
      console.warn(
        `[asset-proxy] upstream failed: ${parsed.toString()} → ${(e as Error).message}`,
      );
      res.setHeader("Cache-Control", "no-store");
      return sendError(res, "UPSTREAM_FAILED", (e as Error).message, 502);
    }
    clearTimeout(timer);

    const contentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";

    // Don't cache 4xx/5xx — the underlying cause is usually transient.
    const cacheControl =
      upstream.status >= 200 && upstream.status < 300
        ? "public, max-age=3600"
        : "no-store";

    if (upstream.status >= 400) {
      console.warn(`[asset-proxy] upstream ${upstream.status} for ${parsed.toString()}`);
    }

    if (/^text\/css/i.test(contentType)) {
      const text = await upstream.text();
      if (Buffer.byteLength(text) > MAX_BYTES) {
        return sendError(res, "TOO_LARGE", "Asset too large", 413);
      }
      const rewritten = rewriteCssUrls(text, parsed);
      res.status(upstream.status);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", cacheControl);
      res.removeHeader("Content-Security-Policy");
      return res.send(rewritten);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return sendError(res, "TOO_LARGE", "Asset too large", 413);
    }
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", cacheControl);
    res.removeHeader("Content-Security-Policy");
    return res.send(buf);
  }),
);

export default router;
