// In-process queue for website thumbnail captures.
//
// Capturing launches Chromium (~10-20s, memory-heavy), so we never do it on the
// request path. `POST /documents/website` creates the doc as PENDING and enqueues
// here; this worker drains the queue one at a time and silently flips the doc to
// READY (+ thumbnail) or FAILED. The doc's `snapshotStatus` IS the durable queue
// state — `recoverPendingCaptures()` re-enqueues anything left PENDING after a
// restart, so no separate jobs table is needed.
import { db } from "@/db";
import { captureUrl } from "@/lib/capture";

// Concurrency 1 — one Chromium at a time is all the Render free instance can
// safely run alongside request handling.
const queuedIds = new Set<string>(); // dedup: waiting or in-flight
const pending: string[] = []; // FIFO of documentIds
let draining = false;

/** Queue a document for (re)capture. Idempotent while a capture is outstanding. */
export function enqueueCapture(documentId: string): void {
  if (queuedIds.has(documentId)) return;
  queuedIds.add(documentId);
  pending.push(documentId);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const documentId = pending.shift()!;
      try {
        await processOne(documentId);
      } catch (e) {
        // processOne handles its own failures; this only catches the unexpected.
        console.error("[capture-queue] unexpected error", documentId, e);
      } finally {
        queuedIds.delete(documentId);
      }
    }
  } finally {
    draining = false;
  }
}

async function processOne(documentId: string): Promise<void> {
  const doc = await db.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.deletedAt || doc.type !== "WEBSITE" || !doc.sourceUrl) return;
  try {
    const result = await captureUrl(doc.sourceUrl);
    await db.document.update({
      where: { id: documentId },
      data: {
        // Only adopt the captured page title if the user never set one (the
        // doc was created with the URL as its placeholder title).
        ...(doc.title === doc.sourceUrl ? { title: result.title } : {}),
        thumbnailKey: result.thumbnailUrl,
        viewportWidth: result.viewportWidth,
        viewportHeight: result.viewportHeight,
        snapshotStatus: "READY",
        lastCapturedAt: new Date(),
        captureError: null,
      },
    });
  } catch (e) {
    const msg = (e as Error).message ?? "capture failed";
    console.error("[capture-queue] capture failed", documentId, msg);
    // Thumbnail is non-essential — the live proxy still works. Record and move on.
    await db.document
      .update({
        where: { id: documentId },
        data: { snapshotStatus: "FAILED", captureError: msg },
      })
      .catch(() => {});
  }
}

/** Re-enqueue any website docs left PENDING (e.g. by a restart mid-capture). */
export async function recoverPendingCaptures(): Promise<void> {
  const docs = await db.document.findMany({
    where: { type: "WEBSITE", snapshotStatus: "PENDING", deletedAt: null },
    select: { id: true },
  });
  for (const d of docs) enqueueCapture(d.id);
  if (docs.length > 0) {
    console.log(`[capture-queue] recovered ${docs.length} pending capture(s)`);
  }
}
