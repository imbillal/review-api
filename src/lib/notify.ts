import { EventEmitter } from "node:events";
import { db } from "@/db";

const bus = new EventEmitter();
bus.setMaxListeners(0);

export type NotificationPayload = {
  id: string;
  userId: string;
  type: "COMMENT_CREATED" | "COMMENT_RESOLVED";
  actorId: string;
  actor: { id: string; name: string; email: string } | null;
  orgId: string;
  orgSlug: string | null;
  projectId: string;
  projectSlug: string | null;
  documentId: string;
  documentTitle: string | null;
  commentId: string;
  readAt: Date | null;
  createdAt: Date;
};

export function subscribe(userId: string, fn: (n: NotificationPayload) => void) {
  bus.on(userId, fn);
  return () => {
    bus.off(userId, fn);
  };
}

async function hydrate(row: {
  id: string;
  userId: string;
  type: "COMMENT_CREATED" | "COMMENT_RESOLVED";
  actorId: string;
  orgId: string;
  projectId: string;
  documentId: string;
  commentId: string;
  readAt: Date | null;
  createdAt: Date;
}): Promise<NotificationPayload> {
  const [actor, project, org, document] = await Promise.all([
    db.user.findUnique({
      where: { id: row.actorId },
      select: { id: true, name: true, email: true },
    }),
    db.project.findUnique({ where: { id: row.projectId }, select: { slug: true } }),
    db.organization.findUnique({ where: { id: row.orgId }, select: { slug: true } }),
    db.document.findUnique({ where: { id: row.documentId }, select: { title: true } }),
  ]);
  return {
    ...row,
    actor: actor ?? null,
    orgSlug: org?.slug ?? null,
    projectSlug: project?.slug ?? null,
    documentTitle: document?.title ?? null,
  };
}

export async function notifyComment(args: {
  type: "COMMENT_CREATED" | "COMMENT_RESOLVED";
  actorId: string;
  comment: { id: string; documentId: string };
}): Promise<void> {
  const doc = await db.document.findUnique({
    where: { id: args.comment.documentId },
    select: {
      id: true,
      projectId: true,
      project: { select: { orgId: true, org: { select: { ownerId: true } } } },
    },
  });
  if (!doc) return;
  const projectId = doc.projectId;
  const orgId = doc.project.orgId;
  const ownerId = doc.project.org.ownerId;
  if (ownerId === args.actorId) return;

  const prefs = await db.notificationPreference.upsert({
    where: { userId_orgId: { userId: ownerId, orgId } },
    update: {},
    create: { userId: ownerId, orgId },
  });
  const allowed =
    (args.type === "COMMENT_CREATED" && prefs.notifyOnCommentCreated) ||
    (args.type === "COMMENT_RESOLVED" && prefs.notifyOnCommentResolved);
  if (!allowed) return;

  const row = await db.notification.create({
    data: {
      userId: ownerId,
      actorId: args.actorId,
      type: args.type,
      orgId,
      projectId,
      documentId: doc.id,
      commentId: args.comment.id,
    },
  });

  const payload = await hydrate(row);
  bus.emit(ownerId, payload);
}
