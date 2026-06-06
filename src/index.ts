import "./bootstrap-env"; // MUST be first — sets PLAYWRIGHT_BROWSERS_PATH before Playwright is imported
import app from "@/app";
import { recoverPendingCaptures } from "@/lib/capture-queue";

const PORT = Number(process.env.PORT ?? 3001);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3100";

app.listen(PORT, () => {
  console.log(`✓ Pinion API listening on http://localhost:${PORT}`);
  console.log(`  CORS origin: ${WEB_ORIGIN}`);
  // Re-enqueue any captures left PENDING by a previous run (e.g. a restart
  // mid-capture). Fire-and-forget — failures are logged, never fatal.
  void recoverPendingCaptures().catch((e) =>
    console.error("[capture-queue] recovery failed", e),
  );
});
