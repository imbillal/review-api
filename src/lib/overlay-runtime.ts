/**
 * Pin overlay runtime. Injected into HTML (captured or proxied) — runs inside
 * the iframe and communicates with the parent Pinion app via postMessage.
 *
 * Outbound messages to parent:
 *   { type: "pinion:ready",     width, height, pageUrl }
 *   { type: "pinion:page-url",  pageUrl }                   (on navigation)
 *   { type: "pinion:click",     selector, path, textHash, xPct, yPct, pageX, pageY, pageUrl }
 *   { type: "pinion:positions", positions, docWidth, docHeight, pageUrl }
 *
 * Inbound messages from parent:
 *   { type: "pinion:set-comments", comments: Array<{ id, selector, path, textHash, xPct, yPct }> }
 *   { type: "pinion:set-mode",     mode: "comment" | "read" }
 *
 * The runtime is shared by the snapshot pipeline (capture.ts) and the live
 * proxy (proxy.ts). Parent handles per-page filtering — this runtime does not.
 */
export const OVERLAY_RUNTIME = `
(function(){
  console.log("[pinion/iframe] runtime boot");
  // If we're not embedded in a parent (someone opened the proxy URL directly),
  // don't intercept anything. Pinion only activates inside its review workspace.
  var IS_EMBEDDED = window.parent && window.parent !== window;
  if (!IS_EMBEDDED) {
    console.log("[pinion/iframe] not embedded — runtime inactive");
    return;
  }
  var comments = [];
  var mode = "comment";

  function currentPageUrl() {
    var p = location.pathname + location.search + location.hash;
    // When served through the proxy, the URL has a /proxy/<id> prefix we must
    // strip so comments are scoped to the *site* path, not the proxy path.
    var pfx = window.__PINION_PREFIX__;
    if (pfx && p.indexOf(pfx) === 0) {
      p = p.substring(pfx.length) || "/";
    }
    return p;
  }

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

  function segmentFor(el) {
    var parent = el.parentElement;
    var tag = el.tagName.toLowerCase();
    if (!parent) return tag;
    var idx = Array.prototype.indexOf.call(parent.children, el);

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
      for (var i = 0; i < classes.length; i++) {
        var cls = classes[i];
        var count = 0;
        for (var j = 0; j < parent.children.length; j++) {
          var c = parent.children[j];
          if (c.classList && c.classList.contains(cls)) count++;
        }
        if (count === 1) return "." + esc(cls);
      }
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
      var x = window.scrollX + r.left + r.width * (c.xPct || 0) / 100;
      var y = window.scrollY + r.top + r.height * (c.yPct || 0) / 100;
      out[c.id] = { x: x, y: y, visible: true };
    }
    var doc = document.documentElement;
    parent.postMessage({
      type: "pinion:positions",
      positions: out,
      docWidth: Math.max(doc.scrollWidth, doc.clientWidth),
      docHeight: Math.max(doc.scrollHeight, doc.clientHeight),
      pageUrl: currentPageUrl()
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
    parent.postMessage({
      type: "pinion:click",
      selector: genSelector(el),
      path: buildPath(el),
      textHash: textHash(el),
      xPct: xPct,
      yPct: yPct,
      pageX: window.scrollX + e.clientX,
      pageY: window.scrollY + e.clientY,
      pageUrl: currentPageUrl()
    }, "*");
  }

  // Track client-side navigation (SPAs override pushState/replaceState)
  var lastPageUrl = currentPageUrl();
  function emitPageUrl() {
    var u = currentPageUrl();
    if (u !== lastPageUrl) {
      lastPageUrl = u;
      parent.postMessage({ type: "pinion:page-url", pageUrl: u }, "*");
      sendPositions();
    }
  }
  ["pushState", "replaceState"].forEach(function(name){
    var orig = history[name];
    history[name] = function() {
      var r = orig.apply(this, arguments);
      setTimeout(emitPageUrl, 0);
      return r;
    };
  });
  window.addEventListener("popstate", emitPageUrl);

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
    console.log("[pinion/iframe] ready, page:", currentPageUrl());
    var doc = document.documentElement;
    parent.postMessage({
      type: "pinion:ready",
      width: Math.max(doc.scrollWidth, doc.clientWidth),
      height: Math.max(doc.scrollHeight, doc.clientHeight),
      pageUrl: currentPageUrl()
    }, "*");
    sendPositions();
  }
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready);
})();
`.trim();

export function injectOverlayRuntime(html: string): string {
  const script = `<script>${OVERLAY_RUNTIME}</script>`;
  if (html.includes("</body>")) return html.replace("</body>", `${script}</body>`);
  return html + script;
}
