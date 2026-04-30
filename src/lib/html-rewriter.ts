import * as cheerio from "cheerio";

/**
 * Rewrite URLs in an HTML document so that:
 *   - Same-origin <a href>, <form action> go through our proxy (/proxy/:id/*?t=token)
 *   - External <a href> stays absolute (opens outside the iframe when clicked)
 *   - Relative <img>, <link>, <script>, <source>, <iframe> src/href become
 *     absolute to the upstream origin (so the browser loads them directly —
 *     no need to proxy static assets)
 *   - Any <base href> is removed so relative URLs resolve against the chosen base
 *   - <meta http-equiv="content-security-policy"> is stripped
 */
export function rewriteHtml(
  html: string,
  opts: {
    sourceUrl: string; // e.g. "https://billal.lol/"
    currentUrl: string; // e.g. "https://billal.lol/about"
    proxyPathPrefix: string; // e.g. "/proxy/abc123"
    proxyOrigin: string; // e.g. "http://localhost:3001" — required because
                         // <base href> points to the upstream site, so relative
                         // proxy URLs would otherwise resolve against it.
    token: string; // signed token to include in every rewritten link
  },
): string {
  const $ = cheerio.load(html, { xml: false });
  const origin = new URL(opts.sourceUrl).origin;
  const currentBase = new URL(opts.currentUrl);

  $("base").remove();
  $('meta[http-equiv="content-security-policy" i]').remove();
  $('meta[http-equiv="X-Frame-Options" i]').remove();

  // Scripts stay. Our pin runtime installs listeners in the CAPTURE phase
  // (addEventListener(..., true)) and in Comment mode stops propagation so
  // site JS never sees pinning clicks. In Read mode the runtime no-ops,
  // letting site JS run normally — hamburger menus, tabs, accordions, etc.
  // Tradeoff: cookie banners and chat widgets may load; users dismiss in Read
  // mode the same way they would on the real site.

  function toProxyUrl(absUrl: string): string {
    const u = new URL(absUrl);
    // Absolute URL so <base href="upstream"> doesn't redirect the browser.
    const pathAndQuery = u.pathname + u.search;
    const sep = u.search ? "&" : "?";
    return `${opts.proxyOrigin}${opts.proxyPathPrefix}${pathAndQuery}${sep}t=${encodeURIComponent(opts.token)}${u.hash}`;
  }

  function resolveAbs(href: string): URL | null {
    try {
      return new URL(href, currentBase);
    } catch {
      return null;
    }
  }

  function rewriteAttr(el: ReturnType<typeof $>, attr: string, navigation: boolean) {
    const v = el.attr(attr);
    if (!v) return;
    if (v.startsWith("#") || v.startsWith("javascript:") || v.startsWith("mailto:") || v.startsWith("tel:")) return;
    const abs = resolveAbs(v);
    if (!abs) return;
    if (navigation) {
      if (abs.origin !== origin) {
        // External — leave absolute so clicks open top-level navigation.
        el.attr(attr, abs.toString());
        return;
      }
      // Same-origin. If it resolves to the SAME page we're currently rendering,
      // shrink to a hash-only anchor so the browser handles it as an in-page
      // jump (smooth scroll) without reloading the iframe.
      const sameDoc =
        abs.pathname === currentBase.pathname &&
        abs.search === currentBase.search;
      if (sameDoc && abs.hash) {
        el.attr(attr, abs.hash);
        return;
      }
      if (sameDoc && !abs.hash) {
        // Link back to the same page with no hash — harmless. Keep unchanged.
        el.attr(attr, abs.hash || "");
        return;
      }
      // Different page, same origin: route through the proxy.
      el.attr(attr, toProxyUrl(abs.toString()));
    } else {
      // Assets: always use absolute URL — browser fetches directly from upstream.
      el.attr(attr, abs.toString());
    }
  }

  // Add <base href> so relative links that JS constructs at runtime still work.
  $("head").prepend(`<base href="${currentBase.toString()}">`);

  // Navigation attributes
  $("a[href]").each((_, node) => rewriteAttr($(node), "href", true));
  $("form[action]").each((_, node) => rewriteAttr($(node), "action", true));

  // Asset attributes (absolutize only — no proxying of assets)
  $("img[src]").each((_, node) => rewriteAttr($(node), "src", false));
  $("img[srcset]").each((_, node) => {
    const set = $(node).attr("srcset");
    if (!set) return;
    const parts = set.split(",").map((p) => {
      const [url, desc] = p.trim().split(/\s+/, 2);
      if (!url) return p;
      const abs = resolveAbs(url);
      return abs ? `${abs.toString()}${desc ? " " + desc : ""}` : p;
    });
    $(node).attr("srcset", parts.join(", "));
  });
  $("link[href]").each((_, node) => rewriteAttr($(node), "href", false));
  $("script[src]").each((_, node) => rewriteAttr($(node), "src", false));
  $("source[src]").each((_, node) => rewriteAttr($(node), "src", false));
  $("video[src]").each((_, node) => rewriteAttr($(node), "src", false));
  $("audio[src]").each((_, node) => rewriteAttr($(node), "src", false));
  $("iframe[src]").each((_, node) => rewriteAttr($(node), "src", false));
  $("track[src]").each((_, node) => rewriteAttr($(node), "src", false));

  return $.html();
}
