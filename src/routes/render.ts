import { Router, type Response } from "express";
import axios from "axios";
import { getBrowser } from "@/lib/getBrowser";
import { asyncHandler } from "@/lib/api";

/**
 * 1:1 port of imbillal/review-trace-api `src/modules/proxy/proxy.controller.js`
 * (renderIframeHandler). Exposed at GET /render.
 */

const router: Router = Router();

const validateUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};

const processHtml = (html: string, baseUrl: string): string => {
  return html
    .replace(
      /if\s*\(\s*(?:window\.)?(?:self|top)\s*[!=]==?\s*(?:window\.)?(?:parent|top)\s*\)/gi,
      "if(false)",
    )
    .replace(/(?:window\.)?(?:self|top)\.location\.href/gi, '"about:blank"')
    .replace(/(?:window\.)?(?:parent|top)\.location/gi, "window.location")
    .replace(/window\.top\.location/gi, "window.location")
    .replace(/parent\.location/gi, "window.location")
    .replace(/top\.location\s*=\s*self\.location/gi, "// frame-busting disabled")
    .replace(/top\.location\s*=\s*location/gi, "// frame-busting disabled")
    .replace(/(<head[^>]*>)/i, `$1<base href="${baseUrl}/">`)
    .replace(
      /(<\/head>)/i,
      `
\t\t\t<script>
\t\t\t\tObject.defineProperty(window, 'top', { value: window, writable: false });
\t\t\t\tObject.defineProperty(window, 'parent', { value: window, writable: false });
\t\t\t\twindow.frameElement = null;
\t\t\t</script>
\t\t\t<style>
\t\t\t\tbody {
\t\t\t\t\tmargin: 0 !important;
\t\t\t\t\tpadding: 10px !important;
\t\t\t\t\toverflow-x: hidden !important;
\t\t\t\t}
\t\t\t\t#root, #app, #__next, [data-reactroot] {
\t\t\t\t\tmin-height: 400px !important;
\t\t\t\t}
\t\t\t</style>
\t\t\t$1`,
    );
};

const setRenderHeaders = (res: Response, renderMethod: "http" | "browser") => {
  res.setHeader("X-Render-Method", renderMethod);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.removeHeader("Content-Security-Policy");
};

async function renderWithBrowser(res: Response, targetUrl: string, timeout: number) {
  const startTime = Date.now();
  let browser: Awaited<ReturnType<typeof getBrowser>> | undefined;
  let page: Awaited<ReturnType<Awaited<ReturnType<typeof getBrowser>>["newPage"]>> | undefined;

  try {
    browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    await page.setViewport({ width: 1280, height: 720 });
    page.setDefaultTimeout(timeout || 10000);

    await page.setRequestInterception(true);
    page.on("request", (interceptedReq) => {
      const resourceType = interceptedReq.resourceType();
      const url = interceptedReq.url();

      if (
        resourceType === "image" ||
        resourceType === "media" ||
        resourceType === "font" ||
        url.includes("analytics") ||
        url.includes("tracking") ||
        url.includes("ads") ||
        url.includes("gtag") ||
        url.includes("facebook.net") ||
        url.includes("doubleclick")
      ) {
        interceptedReq.abort();
        return;
      }
      interceptedReq.continue();
    });

    await page.goto(targetUrl, {
      waitUntil: "networkidle0",
      timeout: timeout || 15000,
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      await page.waitForFunction(
        () => {
          const w = window as unknown as Record<string, unknown>;
          return (
            document.querySelector("#root, #app, #__next, [data-reactroot]") !== null ||
            document.body.children.length > 1 ||
            typeof w["React"] !== "undefined" ||
            typeof w["__NEXT_DATA__"] !== "undefined"
          );
        },
        { timeout: 3000 },
      );
    } catch {
      console.info("[render] React detection timeout, proceeding anyway");
    }

    const html = await page.content();
    const parsedUrl = new URL(targetUrl);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const processedHtml = processHtml(html, baseUrl);

    setRenderHeaders(res, "browser");

    const renderTime = Date.now() - startTime;
    console.log(`[render] browser render completed in ${renderTime}ms: ${targetUrl}`);

    res.send(processedHtml);
  } catch (error) {
    const renderTime = Date.now() - startTime;
    const msg = (error as Error).message;
    console.error(`[render] browser render failed after ${renderTime}ms:`, msg);

    if ((error as Error).name === "TimeoutError") {
      return res.status(408).json({
        message: "Page load timeout. The app took too long to load. Try increasing timeout.",
      });
    }

    res.status(500).json({ message: "Failed to render page with browser" });
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

const detectSpaApp = (html: string): boolean => {
  const indicators = [
    /__NEXT_DATA__/i,
    /react/i,
    /next/i,
    /nuxt/i,
    /vue/i,
    /angular/i,
    /<div[^>]*id=['"](root|app|__next)['"]/i,
    /data-reactroot/i,
    /webpack/i,
    /vite/i,
    /_next\/static/i,
    /chunk.*\.js/i,
    /<body[^>]*>[\s]*<[^>]*id=['"](root|app)/i,
  ];
  return indicators.some((pattern) => pattern.test(html));
};

const hasMinimalContent = (html: string): boolean => {
  const contentOnly = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const textContent = contentOnly.replace(/<[^>]*>/g, "").trim();
  return (
    textContent.length < 200 ||
    /loading|please wait|enable javascript/i.test(textContent)
  );
};

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
    const timeout = Number(req.query.timeout ?? 8000) || 8000;
    const forceMethod = req.query.forceMethod;
    let shouldUseBrowser = forceMethod === "browser";

    if (!targetUrl || !validateUrl(targetUrl)) {
      return res.status(400).json({
        message: "Valid URL parameter required",
        usage: "?url=https://example.com&timeout=8000&forceMethod=browser",
      });
    }

    try {
      let html = "";

      if (!shouldUseBrowser) {
        try {
          const response = await axios.get(targetUrl, {
            timeout: 5000,
            maxRedirects: 5,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
              "Cache-Control": "no-cache",
            },
            validateStatus: (status) => status < 500,
            responseType: "text",
            transformResponse: [(v) => v],
          });

          html = response.data as string;
          const isSpa = detectSpaApp(html);
          const minimal = hasMinimalContent(html);
          shouldUseBrowser = isSpa || minimal;
        } catch (httpError) {
          console.info(
            `[render] HTTP fetch failed, falling back to browser: ${(httpError as Error).message}`,
          );
          shouldUseBrowser = true;
        }
      }

      if (shouldUseBrowser) {
        return await renderWithBrowser(res, targetUrl, timeout);
      }

      const parsedUrl = new URL(targetUrl);
      const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
      const processedHtml = processHtml(html, baseUrl);

      setRenderHeaders(res, "http");

      const renderTime = Date.now() - startTime;
      console.log(`[render] HTTP render completed in ${renderTime}ms: ${targetUrl}`);
      res.send(processedHtml);
    } catch (error) {
      console.error(`[render] smart detection failed: ${(error as Error).message}`);
      if (!shouldUseBrowser) {
        return await renderWithBrowser(res, targetUrl, timeout);
      }
      res.status(500).json({ message: "Failed to render page" });
    }
  }),
);

export default router;
