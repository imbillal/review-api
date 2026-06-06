import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, update, findMany, captureUrl } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
  captureUrl: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: { document: { findUnique, update, findMany } },
}));
vi.mock("@/lib/capture", () => ({ captureUrl }));

type Queue = typeof import("../../../src/lib/capture-queue");
let enqueueCapture: Queue["enqueueCapture"];
let recoverPendingCaptures: Queue["recoverPendingCaptures"];

const websiteDoc = (over: Record<string, unknown> = {}) => ({
  id: "doc1",
  type: "WEBSITE",
  sourceUrl: "https://example.com",
  title: "https://example.com",
  deletedAt: null,
  ...over,
});

const captureOk = {
  thumbnailUrl: "https://cdn/thumb.jpg",
  title: "Example Domain",
  viewportWidth: 1440,
  viewportHeight: 900,
};

beforeEach(async () => {
  findUnique.mockReset();
  update.mockReset();
  findMany.mockReset();
  captureUrl.mockReset();
  update.mockResolvedValue({});
  // Fresh module state (the queue keeps in-memory FIFO/dedup state).
  vi.resetModules();
  ({ enqueueCapture, recoverPendingCaptures } = await import("../../../src/lib/capture-queue"));
});

describe("capture-queue", () => {
  it("captures a queued doc and marks it READY with the thumbnail", async () => {
    findUnique.mockResolvedValue(websiteDoc());
    captureUrl.mockResolvedValue(captureOk);

    enqueueCapture("doc1");

    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(captureUrl).toHaveBeenCalledWith("https://example.com");
    expect(update).toHaveBeenCalledWith({
      where: { id: "doc1" },
      data: expect.objectContaining({
        thumbnailKey: "https://cdn/thumb.jpg",
        title: "Example Domain", // adopted because title === sourceUrl
        snapshotStatus: "READY",
        captureError: null,
      }),
    });
  });

  it("keeps a user-set title (only adopts the captured title when title was the URL)", async () => {
    findUnique.mockResolvedValue(websiteDoc({ title: "My pricing page" }));
    captureUrl.mockResolvedValue(captureOk);

    enqueueCapture("doc1");

    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    const data = update.mock.calls[0]![0].data;
    expect(data.title).toBeUndefined();
    expect(data.snapshotStatus).toBe("READY");
  });

  it("marks the doc FAILED (no throw) when capture errors", async () => {
    findUnique.mockResolvedValue(websiteDoc());
    captureUrl.mockRejectedValue(new Error("boom"));

    enqueueCapture("doc1");

    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith({
      where: { id: "doc1" },
      data: { snapshotStatus: "FAILED", captureError: "boom" },
    });
  });

  it("dedups: enqueueing the same id twice runs capture once", async () => {
    findUnique.mockResolvedValue(websiteDoc());
    captureUrl.mockResolvedValue(captureOk);

    enqueueCapture("doc1");
    enqueueCapture("doc1");

    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(captureUrl).toHaveBeenCalledTimes(1);
  });

  it("skips deleted / non-website docs without capturing", async () => {
    findUnique.mockResolvedValue(websiteDoc({ deletedAt: new Date() }));

    enqueueCapture("doc1");

    await vi.waitFor(() => expect(findUnique).toHaveBeenCalled());
    expect(captureUrl).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("recoverPendingCaptures re-enqueues every PENDING website doc", async () => {
    findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    findUnique.mockResolvedValue(websiteDoc());
    captureUrl.mockResolvedValue(captureOk);

    await recoverPendingCaptures();

    expect(findMany).toHaveBeenCalledWith({
      where: { type: "WEBSITE", snapshotStatus: "PENDING", deletedAt: null },
      select: { id: true },
    });
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  });
});
