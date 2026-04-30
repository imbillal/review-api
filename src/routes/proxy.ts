import { Router, type Request, type Response } from "express";
import { db } from "@/db";
import { sendError, asyncHandler } from "@/lib/api";
import { getUserId } from "@/middleware/auth";
import { resolveAccess } from "@/lib/access";
import { verifyBundleToken, signBundleToken } from "@/lib/bundle-token";
import { injectOverlayRuntime } from "@/lib/overlay-runtime";
import { rewriteHtml } from "@/lib/html-rewriter";

const router: Router = Router();

/**
 * Live-proxy a website document. The user hits
 *   GET /proxy/:documentId/<anything>?t=<token>
 * We fetch the upstream URL (document.sourceUrl + remaining path), strip
 * blocking response headers, rewrite HTML to keep navigation inside the proxy,
 * and inject the pin runtime.
 *
 * Auth: signed token (same HMAC scheme as /documents/:id/bundle). Cookies
 * don't cross origins reliably in dev, so we rely on the token.
 *
 * SSRF defenses: private IPs rejected, 10s timeout, 10 MB max body.
 * Cookies/auth from the user are NOT forwarded upstream — we never want to
 * leak Pinion sessions to third-party sites.
 */
router.use("/:documentId", asyncHandler(async (req: Request, res: Response) => {
  const docId = req.params.documentId!;
  let userId = await getUserId(req);
  const t = typeof req.query.t === "string" ? req.query.t : null;
  if (!userId && t) {
    const v = verifyBundleToken(t, docId);
    if (v) userId = v.userId;
  }
  if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);

  const doc = await db.document.findUnique({ where: { id: docId } });
  if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Document not found", 404);
  if (doc.type !== "WEBSITE" || !doc.sourceUrl)
    return sendError(res, "WRONG_TYPE", "Not a website document", 400);

  const role = await resolveAccess(userId, { kind: "document", documentId: doc.id });
  if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);

  // Build the upstream URL
  // req.path after mount point (/proxy/:documentId) — the rest is the site's
  // relative path. Example:
  //   request:  /proxy/abc123/about?a=1
  //   doc URL:  https://billal.lol/
  //   upstream: https://billal.lol/about?a=1
  const baseUrl = new URL(doc.sourceUrl);
  const mountPrefix = `/proxy/${docId}`;
  const full = req.originalUrl; // includes query string
  let rel = full.startsWith(mountPrefix) ? full.slice(mountPrefix.length) : "/";
  // Strip the t= param (if present) from the upstream request — upstream
  // shouldn't see our auth token.
  rel = stripParam(rel, "t");
  if (!rel || rel === "") rel = "/";
  const upstream = new URL(rel.startsWith("/") ? rel : "/" + rel, baseUrl).toString();

  // SSRF: block private hosts
  const host = new URL(upstream).hostname;
  if (
    host === "localhost" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local")
  ) {
    return sendError(res, "SSRF_BLOCKED", "Private host not allowed", 403);
  }

  // Fetch upstream. 10s timeout, 10 MB max.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let upstreamResp: Response | globalThis.Response;
  try {
    upstreamResp = await fetch(upstream, {
      method: req.method === "GET" || req.method === "HEAD" ? req.method : "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; PinionProxy/1.0; +https://pinion.dev)",
        accept: req.get("accept") ?? "*/*",
        "accept-language": req.get("accept-language") ?? "en",
      },
    });
  } catch (e) {
    clearTimeout(timeout);
    return sendError(res, "UPSTREAM_FAILED", (e as Error).message, 502);
  }
  clearTimeout(timeout);

  const contentType = upstreamResp.headers.get("content-type") ?? "application/octet-stream";

  // For HTML, rewrite + inject pin runtime. For other types, pass through.
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    const text = await upstreamResp.text();
    // Size check
    if (text.length > 10 * 1024 * 1024) {
      return sendError(res, "TOO_LARGE", "Upstream body > 10 MB", 502);
    }
    // Mint a fresh token for this user/doc so all rewritten links work.
    const linkToken = t ?? signBundleToken(userId, docId);
    const proxyOrigin = `${req.protocol}://${req.get("host")}`;
    const rewritten = rewriteHtml(text, {
      sourceUrl: doc.sourceUrl,
      currentUrl: upstream,
      proxyPathPrefix: `/proxy/${docId}`,
      proxyOrigin,
      token: linkToken,
    });
    // Inject prefix so the pin runtime can strip it from location.pathname
    const prefixTag = `<script>window.__PINION_PREFIX__ = ${JSON.stringify(`/proxy/${docId}`)};</script>`;
    const withPrefix = rewritten.replace("</head>", `${prefixTag}</head>`);
    const withRuntime = injectOverlayRuntime(withPrefix);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(upstreamResp.status).send(withRuntime);
    return;
  }

  // Non-HTML (shouldn't usually hit us — assets use absolute URLs). Pass through.
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", upstreamResp.headers.get("cache-control") ?? "no-store");
  const body = Buffer.from(await upstreamResp.arrayBuffer());
  res.status(upstreamResp.status).send(body);
}));

function stripParam(url: string, param: string): string {
  const idx = url.indexOf("?");
  if (idx < 0) return url;
  const path = url.slice(0, idx);
  const qs = url.slice(idx + 1);
  const kept = qs
    .split("&")
    .filter((p) => p.length > 0 && p.split("=")[0] !== param)
    .join("&");
  return kept ? `${path}?${kept}` : path;
}

export default router;
