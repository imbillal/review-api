import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @/db before importing notify.ts
const { findUnique, upsert, create, findUniqueUser, findUniqueProject, findUniqueOrg } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  create: vi.fn(),
  findUniqueUser: vi.fn(),
  findUniqueProject: vi.fn(),
  findUniqueOrg: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    document: { findUnique },
    notificationPreference: { upsert },
    notification: { create },
    user: { findUnique: findUniqueUser },
    project: { findUnique: findUniqueProject },
    organization: { findUnique: findUniqueOrg },
  },
}));

import { notifyComment, subscribe, type NotificationPayload } from "../../../src/lib/notify";

const docFixture = {
  id: "doc1",
  projectId: "proj1",
  project: { orgId: "org1", org: { ownerId: "owner1" } },
};

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
  create.mockReset();
  findUniqueUser.mockReset();
  findUniqueProject.mockReset();
  findUniqueOrg.mockReset();
  // Sane hydrate() defaults
  findUniqueUser.mockResolvedValue({ id: "alice", name: "Alice", email: "a@b.com" });
  findUniqueProject.mockResolvedValue({ id: "proj1", slug: "p" });
  findUniqueOrg.mockResolvedValue({ id: "org1", slug: "o" });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("notifyComment", () => {
  it("does nothing when document is missing", async () => {
    findUnique.mockResolvedValue(null);
    await notifyComment({ type: "COMMENT_CREATED", actorId: "alice", comment: { id: "c1", documentId: "doc1" } });
    expect(upsert).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does nothing when actor is the org owner", async () => {
    findUnique.mockResolvedValue(docFixture);
    await notifyComment({ type: "COMMENT_CREATED", actorId: "owner1", comment: { id: "c1", documentId: "doc1" } });
    expect(upsert).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("skips when COMMENT_CREATED pref is off", async () => {
    findUnique.mockResolvedValue(docFixture);
    upsert.mockResolvedValue({ notifyOnCommentCreated: false, notifyOnCommentResolved: true });
    await notifyComment({ type: "COMMENT_CREATED", actorId: "alice", comment: { id: "c1", documentId: "doc1" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("skips when COMMENT_RESOLVED pref is off", async () => {
    findUnique.mockResolvedValue(docFixture);
    upsert.mockResolvedValue({ notifyOnCommentCreated: true, notifyOnCommentResolved: false });
    await notifyComment({ type: "COMMENT_RESOLVED", actorId: "alice", comment: { id: "c1", documentId: "doc1" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("persists row and emits when pref is on", async () => {
    findUnique.mockResolvedValue(docFixture);
    upsert.mockResolvedValue({ notifyOnCommentCreated: true, notifyOnCommentResolved: true });
    create.mockResolvedValue({
      id: "n1", userId: "owner1", type: "COMMENT_CREATED", actorId: "alice",
      orgId: "org1", projectId: "proj1", documentId: "doc1", commentId: "c1",
      readAt: null, createdAt: new Date(),
    });

    const seen: NotificationPayload[] = [];
    const unsub = subscribe("owner1", (n: NotificationPayload) => seen.push(n));

    await notifyComment({ type: "COMMENT_CREATED", actorId: "alice", comment: { id: "c1", documentId: "doc1" } });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data).toMatchObject({
      userId: "owner1",
      actorId: "alice",
      type: "COMMENT_CREATED",
      orgId: "org1",
      projectId: "proj1",
      documentId: "doc1",
      commentId: "c1",
    });
    expect(seen).toHaveLength(1);
    unsub();
  });

  it("subscribe unsub stops further deliveries", async () => {
    findUnique.mockResolvedValue(docFixture);
    upsert.mockResolvedValue({ notifyOnCommentCreated: true, notifyOnCommentResolved: true });
    create.mockResolvedValue({
      id: "n1", userId: "owner1", type: "COMMENT_CREATED", actorId: "alice",
      orgId: "org1", projectId: "proj1", documentId: "doc1", commentId: "c1",
      readAt: null, createdAt: new Date(),
    });

    const seen: NotificationPayload[] = [];
    const unsub = subscribe("owner1", (n: NotificationPayload) => seen.push(n));
    unsub();

    await notifyComment({ type: "COMMENT_CREATED", actorId: "alice", comment: { id: "c1", documentId: "doc1" } });

    expect(seen).toHaveLength(0);
  });
});
