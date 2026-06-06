// Side-effect module — MUST be imported before anything that pulls in Playwright.
//
// Playwright resolves its browsers directory once, at import time, by reading
// PLAYWRIGHT_BROWSERS_PATH. We install Chromium into node_modules during
// `postinstall` (PLAYWRIGHT_BROWSERS_PATH=0), because Render's default
// ~/.cache/ms-playwright is not reliably carried from build to runtime — that
// gap is what produced CAPTURE_FAILED ("Executable doesn't exist at
// /opt/render/.cache/ms-playwright/..."). Pinning the runtime path here (and in
// the `start` script) makes the install path and the launch path agree on "0".
//
// This runs before the `import app` in index.ts: TypeScript hoists imports above
// other statements, so a setting written inline in index.ts would run too late —
// a dedicated side-effect import is the only ordering that's guaranteed.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
}
