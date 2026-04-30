import { chromium } from "playwright";
import { v2 as cloudinary } from "cloudinary";
import { Buffer } from "node:buffer";

export type CaptureResult = {
  thumbnailUrl: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
};

/**
 * Capture a thumbnail + title for a website. The full HTML is no longer
 * captured — we always render via the live proxy. This step only exists to
 * populate the folder-card preview image.
 */
export async function captureUrl(url: string): Promise<CaptureResult> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("URL must start with http(s)://");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36 PinionBot/1.0",
    });
    const page = await context.newPage();
    await page.goto(url, { timeout: 20_000, waitUntil: "networkidle" });
    const title = (await page.title()) || url;

    const thumbBuffer = await page.screenshot({
      type: "jpeg",
      quality: 75,
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
    const thumbUpload = await uploadBuffer(thumbBuffer, {
      resource_type: "image",
      folder: "pinion/websites",
      format: "jpg",
    });

    return {
      thumbnailUrl: thumbUpload.secure_url,
      title,
      viewportWidth: 1440,
      viewportHeight: 900,
    };
  } finally {
    await browser.close();
  }
}

// The overlay runtime + injectOverlayRuntime live in ./overlay-runtime.ts
// (shared by the proxy service). The old inline copy below is left commented
// out for reference and removed by the subsequent edit.
const OVERLAY_RUNTIME_UNUSED = `
(function(){
  console.log("[pinion/iframe] runtime boot");
  var comments = [];
  var mode = "comment";

  function textHash(el) {
    var t = (el.textContent || "").slice(0, 120).trim();
    var h = 0;
    for (var i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
    return el.tagName.toLowerCase() + ":" + t.length + ":" + h;
  }

  function buildPath(el) {
    var parts = [], cur = el;
    while (cur && cur.tagName !== "BODY") {
      var p = cur.parentElement;
      var idx = p ? Array.prototype.indexOf.call(p.children, cur) : 0;
      parts.unshift(cur.tagName.toLowerCase() + "[" + idx + "]");
      cur = p;
    }
    return parts.join("/");
  }

  function findByPath(path) {
    var segs = path.split("/"), node = document.body;
    for (var i = 0; i < segs.length; i++) {
      if (!node) return null;
      var m = segs[i].match(/^(\\w+)\\[(\\d+)\\]$/);
      if (!m) return null;
      var child = node.children[Number(m[2])];
      if (!child || child.tagName.toLowerCase() !== m[1]) return null;
      node = child;
    }
    return node;
  }

  function esc(s) {
    try { return CSS.escape(s); } catch(e) { return s; }
  }

  /** Pick the most resilient/readable selector segment for one element,
   *  relative to its parent. Preferences:
   *    1. An id that's unique in the document  -> "#id"
   *    2. A class that's unique among parent's children  -> ".class"
   *    3. If has classes but none unique  -> "tag:nth-child(N).class"
   *    4. Otherwise  -> "tag:nth-child(N)"
   */
  function segmentFor(el) {
    var parent = el.parentElement;
    var tag = el.tagName.toLowerCase();
    if (!parent) return tag;
    var idx = Array.prototype.indexOf.call(parent.children, el);

    // Document-unique id wins
    if (el.id) {
      try {
        var idSel = "#" + esc(el.id);
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      } catch(e){}
    }

    var classes = [];
    if (el.classList && el.classList.length) {
      for (var ci = 0; ci < el.classList.length; ci++) classes.push(el.classList[ci]);
    }

    if (classes.length > 0) {
      // Class unique among siblings?
      for (var i = 0; i < classes.length; i++) {
        var cls = classes[i];
        var count = 0;
        for (var j = 0; j < parent.children.length; j++) {
          var c = parent.children[j];
          if (c.classList && c.classList.contains(cls)) count++;
        }
        if (count === 1) return "." + esc(cls);
      }
      // None unique — tag:nth-child(N).firstClass (readable + precise)
      return tag + ":nth-child(" + (idx + 1) + ")." + esc(classes[0]);
    }

    return tag + ":nth-child(" + (idx + 1) + ")";
  }

  function genSelector(el) {
    if (!el || el === document.body) return "body";
    var parts = [], cur = el;
    while (cur && cur.parentElement && cur !== document.body) {
      parts.unshift(segmentFor(cur));
      cur = cur.parentElement;
    }
    return "body > " + parts.join(" > ");
  }

  function resolve(c) {
    // Primary: elementPath (absolute child-index walk from body — always
    // unique, no CSS-escape quirks). Fall back to selector, then text hash.
    var candidate = null;
    if (c.path) {
      var el = findByPath(c.path);
      if (el) {
        if (!c.textHash || textHash(el) === c.textHash) return el;
        candidate = el;
      }
    }
    if (c.selector) {
      try {
        var matches = document.querySelectorAll(c.selector);
        for (var i = 0; i < matches.length; i++) {
          if (!c.textHash || textHash(matches[i]) === c.textHash) return matches[i];
        }
        if (matches.length > 0 && !candidate) candidate = matches[0];
      } catch(e){}
    }
    if (c.textHash) {
      var tag = c.textHash.split(":")[0];
      var list = document.getElementsByTagName(tag);
      for (var j = 0; j < list.length; j++) {
        if (textHash(list[j]) === c.textHash) return list[j];
      }
    }
    return candidate;
  }

  function sendPositions() {
    var out = {};
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      var el = resolve(c);
      if (!el) { out[c.id] = { x: 0, y: 0, visible: false }; continue; }
      var r = el.getBoundingClientRect();
      // Iframe-page coords. Since parent resizes iframe to its content height,
      // there's no internal iframe scroll (scrollX/Y stay 0), so rect.left/top
      // already ARE page coords.
      var x = window.scrollX + r.left + r.width * (c.xPct || 0) / 100;
      var y = window.scrollY + r.top + r.height * (c.yPct || 0) / 100;
      out[c.id] = { x: x, y: y, visible: true };
    }
    var doc = document.documentElement;
    parent.postMessage({
      type: "pinion:positions",
      positions: out,
      docWidth: Math.max(doc.scrollWidth, doc.clientWidth),
      docHeight: Math.max(doc.scrollHeight, doc.clientHeight)
    }, "*");
  }

  function onClick(e) {
    if (mode !== "comment") return;
    var a = e.target.closest && e.target.closest("a");
    if (a) e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el === document.body) return;
    var r = el.getBoundingClientRect();
    var xPct = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    var yPct = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
    var sel = genSelector(el);
    var pth = buildPath(el);
    console.log("[pinion/iframe] click → element:", el, "selector:", sel);
    // Verify the selector actually resolves back to the clicked element
    try {
      var verified = document.querySelector(sel);
      if (verified !== el) console.warn("[pinion/iframe] selector self-check FAILED");
    } catch(e){}
    parent.postMessage({
      type: "pinion:click",
      selector: sel,
      path: pth,
      textHash: textHash(el),
      xPct: xPct,
      yPct: yPct,
      pageX: window.scrollX + e.clientX,
      pageY: window.scrollY + e.clientY
    }, "*");
  }

  window.addEventListener("message", function(e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "pinion:set-comments") { comments = d.comments || []; sendPositions(); }
    else if (d.type === "pinion:set-mode") { mode = d.mode; }
  });

  document.addEventListener("click", onClick, true);
  window.addEventListener("scroll", sendPositions, { passive: true });
  window.addEventListener("resize", sendPositions);
  if ("ResizeObserver" in window) {
    try { new ResizeObserver(sendPositions).observe(document.body); } catch(e){}
  }
  function ready() {
    console.log("[pinion/iframe] ready, posting to parent");
    var doc = document.documentElement;
    parent.postMessage({
      type: "pinion:ready",
      width: Math.max(doc.scrollWidth, doc.clientWidth),
      height: Math.max(doc.scrollHeight, doc.clientHeight)
    }, "*");
    sendPositions();
  }
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready);
})();
`.trim();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unusedRef = OVERLAY_RUNTIME_UNUSED;

async function uploadBuffer(
  buffer: Buffer,
  opts: { resource_type: "raw" | "image"; folder: string; public_id?: string; format?: string },
): Promise<{ secure_url: string; public_id: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: opts.resource_type,
        folder: opts.folder,
        format: opts.format,
        unique_filename: true,
      },
      (err, result) => {
        if (err || !result) return reject(err ?? new Error("Upload failed"));
        resolve({ secure_url: result.secure_url, public_id: result.public_id });
      },
    );
    stream.end(buffer);
  });
}
