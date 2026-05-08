import {Router} from 'express';
import * as cheerio from 'cheerio';
import {getBrowser} from '@/lib/getBrowser';
import {asyncHandler} from '@/lib/api';

/**
 * Public, no-auth endpoint that loads a URL with a headless browser and
 * returns its rendered HTML. Mounted at `/dom`.
 *
 *   GET /dom?url=https://example.com[&timeout=15000]
 *
 * Iframe-friendly headers: X-Frame-Options ALLOWALL, no CSP, permissive CORS
 * (the global CORS in app.ts already allows all origins).
 *
 * Asset URLs in the returned HTML are rewritten through `/asset-proxy?url=…`
 * so subresources load same-origin to the iframe — defeats CORS blocks on
 * crossorigin="" Vite assets, hotlink protection, restrictive CORS, etc.
 */
const router: Router = Router();

const DEFAULT_TIMEOUT_MS = 15_000;

function isValidHttpUrl(raw: string): URL | null {
	try {
		const u = new URL(raw);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return u;
	} catch {
		return null;
	}
}

// Schemes / fragments we should never rewrite.
const SKIP_SCHEMES = [
	'data:',
	'blob:',
	'about:',
	'javascript:',
	'mailto:',
	'tel:',
	'#',
];

function resolveAbs(raw: string, currentBase: URL): URL | null {
	if (!raw) return null;
	if (SKIP_SCHEMES.some((s) => raw.startsWith(s))) return null;
	try {
		const abs = new URL(raw, currentBase);
		if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
		return abs;
	} catch {
		return null;
	}
}

/**
 * Build a runtime shim that monkey-patches fetch / XHR / sendBeacon so
 * URLs constructed by the page's own JavaScript at runtime (SPA data
 * fetches, analytics beacons, dynamic <img> srcs via fetch, etc.) flow
 * through /asset-proxy the same way static <link>/<img>/<script> URLs do.
 *
 * Without this, a Vue/React/Angular SPA's first `fetch('/api/...')` call
 * resolves against the iframe's location (localhost:4000) and 404s.
 */
function buildRuntimeShim(upstreamBase: string, proxyPrefix: string): string {
	// Embed values as JSON-escaped string literals — safe inside <script>.
	const U = JSON.stringify(upstreamBase);
	const P = JSON.stringify(proxyPrefix);
	return `
(function(){
  var UPSTREAM = ${U};
  var PROXY = ${P};
  function proxify(u){
    if (u == null) return u;
    var s = (typeof u === 'string') ? u
          : (u && typeof u.url === 'string') ? u.url
          : (u && u.toString) ? u.toString()
          : String(u);
    if (!s) return u;
    if (/^(data|blob|javascript|mailto|tel|about|ws|wss):/i.test(s)) return u;
    try {
      var abs = new URL(s, UPSTREAM);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
      var out = abs.toString();
      if (out.indexOf(PROXY) === 0) return u; // already proxied
      return PROXY + encodeURIComponent(out);
    } catch (e) { return u; }
  }
  // --- fetch ---
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch.bind(window);
    window.fetch = function(input, init){
      try {
        if (typeof input === 'string') {
          input = proxify(input);
        } else if (input && typeof input.url === 'string') {
          var nu = proxify(input.url);
          if (nu !== input.url) input = new Request(nu, input);
        }
      } catch (e) {}
      return origFetch(input, init);
    };
  }
  // --- XMLHttpRequest.open ---
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      var args = Array.prototype.slice.call(arguments);
      try { args[1] = proxify(url); } catch (e) {}
      return origOpen.apply(this, args);
    };
  } catch (e) {}
  // --- sendBeacon ---
  if (navigator && typeof navigator.sendBeacon === 'function') {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data){ return origBeacon(proxify(url), data); };
  }
})();`.trim();
}

/**
 * Rewrite URLs in upstream HTML so:
 *   - Asset attrs (<link>/<img>/<script>/<source>/<video>/<audio>/<track>,
 *     srcset) → absolute proxy URL (browser loads them same-origin).
 *   - Navigation attrs (<a href>, <form action>, <iframe src>) → absolutized
 *     to the upstream so clicks behave the way they would on the live site.
 *   - Inject `<base href>` so runtime relative URLs resolve against upstream.
 *   - Inject runtime shim so fetch / XHR / sendBeacon also flow through proxy.
 */
function rewriteAssets(
	rawHtml: string,
	targetUrl: URL,
	proxyPrefix: string,
): string {
	const $ = cheerio.load(rawHtml, {xml: false});

	// Replace any pre-existing <base> with one anchored to the upstream — so
	// SPA code that does fetch("/api/x") or new URL("./img", document.baseURI)
	// resolves to upstream first. Our shim then re-routes through /asset-proxy.
	$('base').remove();
	$('head').prepend(`<base href="${targetUrl.toString()}">`);

	// Runtime shim must be the FIRST script — ahead of any of the page's own
	// scripts so fetch/XHR are patched before they're called.
	$('head').prepend(
		`<script>${buildRuntimeShim(targetUrl.toString(), proxyPrefix)}</script>`,
	);

	// Strip CSP/X-Frame-Options meta directives the upstream may have set.
	$('meta[http-equiv="content-security-policy" i]').remove();
	$('meta[http-equiv="X-Frame-Options" i]').remove();

	const upstreamOrigin = targetUrl.origin;

	function rewriteAssetAttr(node: ReturnType<typeof $>, attr: string) {
		const v = node.attr(attr);
		if (!v) return;
		const abs = resolveAbs(v, targetUrl);
		if (!abs) return;
		// Only proxy assets that live on the SAME origin as the upstream
		// (`?url=` target). Third-party CDNs / Google fonts / analytics etc.
		// are absolutized in-place and load directly cross-origin from the
		// browser — they generally serve permissive CORS, and proxying them
		// just adds latency + risks transcoding bugs (e.g. CDN-only encodings).
		if (abs.origin !== upstreamOrigin) {
			node.attr(attr, abs.toString());
			return;
		}
		node.attr(attr, `${proxyPrefix}${encodeURIComponent(abs.toString())}`);
		// Same-origin to the iframe now → the original CORS-mode fetch is no
		// longer needed and SRI hash references the unproxied bytes.
		node.removeAttr('crossorigin');
		node.removeAttr('integrity');
	}

	function absolutizeNavAttr(node: ReturnType<typeof $>, attr: string) {
		const v = node.attr(attr);
		if (!v) return;
		const abs = resolveAbs(v, targetUrl);
		if (abs) node.attr(attr, abs.toString());
	}

	// Assets through the proxy.
	$('img[src]').each((_, n) => rewriteAssetAttr($(n), 'src'));
	$('link[href]').each((_, n) => rewriteAssetAttr($(n), 'href'));
	$('script[src]').each((_, n) => rewriteAssetAttr($(n), 'src'));
	$('source[src]').each((_, n) => rewriteAssetAttr($(n), 'src'));
	$('video[src]').each((_, n) => rewriteAssetAttr($(n), 'src'));
	$('video[poster]').each((_, n) => rewriteAssetAttr($(n), 'poster'));
	$('audio[src]').each((_, n) => rewriteAssetAttr($(n), 'src'));
	$('track[src]').each((_, n) => rewriteAssetAttr($(n), 'src'));

	// srcset: comma-separated `<url> <descriptor>` entries. Same same-origin
	// gate as rewriteAssetAttr — third-party CDN entries get absolutized only.
	$('img[srcset], source[srcset]').each((_, n) => {
		const $n = $(n);
		const set = $n.attr('srcset');
		if (!set) return;
		const parts = set.split(',').map((p) => {
			const trimmed = p.trim();
			if (!trimmed) return p;
			const [url, ...descriptor] = trimmed.split(/\s+/);
			const abs = url ? resolveAbs(url, targetUrl) : null;
			if (!abs) return trimmed;
			const next =
				abs.origin === upstreamOrigin
					? `${proxyPrefix}${encodeURIComponent(abs.toString())}`
					: abs.toString();
			return descriptor.length ? `${next} ${descriptor.join(' ')}` : next;
		});
		$n.attr('srcset', parts.join(', '));
		$n.removeAttr('crossorigin');
	});

	// Navigation attrs: absolutize only — clicking goes to the live site.
	$('a[href]').each((_, n) => absolutizeNavAttr($(n), 'href'));
	$('form[action]').each((_, n) => absolutizeNavAttr($(n), 'action'));
	$('iframe[src]').each((_, n) => absolutizeNavAttr($(n), 'src'));

	return $.html();
}

router.get(
	'/',
	asyncHandler(async (req, res) => {
		const target = typeof req.query.url === 'string' ? req.query.url : '';
		const timeout =
			Number(req.query.timeout ?? DEFAULT_TIMEOUT_MS) ||
			DEFAULT_TIMEOUT_MS;

		const parsed = isValidHttpUrl(target);
		if (!parsed) {
			return res.status(400).json({
				message: 'Valid http(s) ?url= required',
				usage: '/dom?url=https://example.com&timeout=15000',
			});
		}

		const start = Date.now();
		let browser: Awaited<ReturnType<typeof getBrowser>> | undefined;
		let page:
			| Awaited<
					ReturnType<
						Awaited<ReturnType<typeof getBrowser>>['newPage']
					>
			  >
			| undefined;

		try {
			browser = await getBrowser();
			page = await browser.newPage();
			await page.setUserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
			);
			await page.setViewport({width: 1280, height: 720});

			await page.goto(parsed.toString(), {
				waitUntil: 'networkidle0',
				timeout,
			});

			const rawHtml = await page.content();

			// Asset-proxy prefix is derived from THIS request — protocol + host of
			// the server actually running /asset-proxy. That's the only host where
			// /asset-proxy is reachable, so the upstream-derived variant doesn't
			// work for arbitrary domains (https://billal.dev/asset-proxy?... would
			// hit the real billal.dev, which has no /asset-proxy route).
			//
			//   hit via localhost:4000        → http://localhost:4000/asset-proxy?url=…
			//   hit via your prod API domain  → https://<that domain>/asset-proxy?url=…
			const proxyPrefix = `${req.protocol}://${req.get('host')}/asset-proxy?url=`;
			const html = rewriteAssets(rawHtml, parsed, proxyPrefix);

			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.setHeader('X-Frame-Options', 'ALLOWALL');
			res.setHeader('Cache-Control', 'no-store');
			res.removeHeader('Content-Security-Policy');

			const elapsed = Date.now() - start;
			console.log(
				`[dom] rendered ${parsed.toString()} in ${elapsed}ms (${html.length} bytes)`,
			);
			res.send(html);
		} catch (error) {
			const err = error as Error;
			const elapsed = Date.now() - start;
			console.error(
				`[dom] failed for ${parsed.toString()} after ${elapsed}ms: ${err.name}: ${err.message}`,
			);
			const isTimeout = err.name === 'TimeoutError';
			res.status(isTimeout ? 408 : 500).json({
				message: isTimeout
					? 'Page load timeout — try increasing ?timeout='
					: 'Failed to render page',
				targetUrl: parsed.toString(),
				error: err.message,
			});
		} finally {
			if (page) await page.close().catch(() => {});
			if (browser) await browser.close().catch(() => {});
		}
	}),
);

export default router;
