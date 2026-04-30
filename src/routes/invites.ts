import { Router } from "express";
import { db } from "@/db";
import { sendError, asyncHandler } from "@/lib/api";
import { requireAuth, getUserId } from "@/middleware/auth";

const router: Router = Router();

router.get(
  "/pending",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const user = await db.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const rows = await db.invite.findMany({
      where: {
        email: user.email,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(rows);
  }),
);

router.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const invite = await db.invite.findUnique({ where: { token: req.params.token! } });
    if (!invite) return sendError(res, "NOT_FOUND", "Invite not found", 404);
    if (invite.acceptedAt) return sendError(res, "ALREADY_ACCEPTED", "Already used", 410);
    if (invite.expiresAt < new Date()) return sendError(res, "EXPIRED", "Invite has expired", 410);

    let scopeName = "";
    if (invite.scopeType === "ORG") {
      const org = await db.organization.findUnique({ where: { id: invite.scopeId } });
      scopeName = org?.name ?? "";
    } else if (invite.scopeType === "PROJECT") {
      const ids = invite.scopeIds.length ? invite.scopeIds : [invite.scopeId];
      const projects = await db.project.findMany({
        where: { id: { in: ids } },
        select: { name: true },
      });
      scopeName = projects.map((p) => p.name).join(", ");
    } else {
      const d = await db.document.findUnique({ where: { id: invite.scopeId } });
      scopeName = d?.title ?? "";
    }
    res.json({
      email: invite.email,
      role: invite.role,
      scopeType: invite.scopeType,
      scopeName,
      expiresAt: invite.expiresAt,
    });
  }),
);

router.post(
  "/:token/accept",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const invite = await db.invite.findUnique({ where: { token: req.params.token! } });
    if (!invite) return sendError(res, "NOT_FOUND", "Invite not found", 404);
    if (invite.acceptedAt) return sendError(res, "ALREADY_ACCEPTED", "Already used", 410);
    if (invite.expiresAt < new Date()) return sendError(res, "EXPIRED", "Invite expired", 410);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return sendError(res, "EMAIL_MISMATCH", "Invite sent to a different email", 403);
    }
    await db.$transaction(async (tx) => {
      if (invite.scopeType === "ORG") {
        await tx.orgMember.upsert({
          where: { userId_orgId: { userId, orgId: invite.scopeId } },
          update: {},
          create: { userId, orgId: invite.scopeId, role: invite.role, invitedBy: invite.invitedBy },
        });
      } else if (invite.scopeType === "PROJECT") {
        const projectIds = invite.scopeIds.length ? invite.scopeIds : [invite.scopeId];
        for (const projectId of projectIds) {
          await tx.projectMember.upsert({
            where: { userId_projectId: { userId, projectId } },
            update: {},
            create: { userId, projectId, role: invite.role, invitedBy: invite.invitedBy },
          });
        }
      } else {
        await tx.documentMember.upsert({
          where: { userId_documentId: { userId, documentId: invite.scopeId } },
          update: {},
          create: { userId, documentId: invite.scopeId, role: invite.role, invitedBy: invite.invitedBy },
        });
      }
      await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    });
    res.json({ ok: true, scopeType: invite.scopeType, scopeId: invite.scopeId });
  }),
);

export default router;
