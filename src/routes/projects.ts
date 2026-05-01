import { Router } from "express";
import { z } from "zod";
import { db } from "@/db";
import { slugify, ensureUniqueSlug } from "@/lib/slug";
import { sendError, parseBody, handlePrismaError, asyncHandler } from "@/lib/api";
import { requireAuth, requireAccess, getUserId } from "@/middleware/auth";
import { resolveAccess, roleMeets } from "@/lib/access";
import { generateToken } from "@/lib/tokens";
import { sendEmail, inviteEmailHtml } from "@/lib/email";
import { deleteByUrls } from "@/lib/storage";

const router: Router = Router();
const createSchema = z.object({ orgId: z.string(), name: z.string().min(1).max(120) });
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  archived: z.boolean().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "COMPLETE"]).optional(),
});
const inviteSchema = z.object({
  email: z.string().email().toLowerCase(),
  role: z.enum(["ADMIN", "REVIEWER"]),
});
const patchMemberSchema = z.object({ role: z.enum(["ADMIN", "REVIEWER"]) });

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const orgId = typeof req.query.orgId === "string" ? req.query.orgId : null;
    if (!orgId) return sendError(res, "MISSING_PARAM", "orgId required", 400);

    // Filter archived after fetch — Prisma + Mongo has a known quirk where
    // `archivedAt: null` returns 0 rows even when values are explicitly null.
    const orgRole = await resolveAccess(userId, { kind: "org", orgId });
    const all = orgRole
      ? await db.project.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } })
      : await db.project.findMany({
          where: { orgId, members: { some: { userId } } },
          orderBy: { createdAt: "desc" },
        });
    res.json(all.filter((p) => p.archivedAt == null));
  }),
);

router.post(
  "/",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, createSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const { orgId, name } = parsed.data;
    const role = await resolveAccess(req.userId!, { kind: "org", orgId });
    if (!role || !roleMeets(role, "ADMIN")) {
      return sendError(res, "FORBIDDEN", "Must be org admin to create projects", 403);
    }
    const base = slugify(name);
    try {
      const slug = await ensureUniqueSlug(base, async (s) => {
        const row = await db.project.findUnique({ where: { orgId_slug: { orgId, slug: s } } });
        return row != null;
      });
      const project = await db.project.create({
        data: {
          orgId,
          name,
          slug,
          createdById: req.userId!,
          members: { create: { userId: req.userId!, role: "ADMIN" } },
        },
      });
      res.status(201).json(project);
    } catch (e) {
      if (handlePrismaError(e, res)) return;
      throw e;
    }
  }),
);

router.get(
  "/:projectId",
  requireAccess("REVIEWER", (req) => ({ kind: "project", projectId: req.params.projectId! })),
  asyncHandler(async (req, res) => {
    const project = await db.project.findUnique({ where: { id: req.params.projectId! } });
    res.json(project);
  }),
);

router.patch(
  "/:projectId",
  requireAccess("ADMIN", (req) => ({ kind: "project", projectId: req.params.projectId! })),
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, updateSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const { name, archived } = parsed.data;
    try {
      const project = await db.project.update({
        where: { id: req.params.projectId! },
        data: {
          name,
          archivedAt: archived === true ? new Date() : archived === false ? null : undefined,
          status: parsed.data.status,
        },
      });
      res.json(project);
    } catch (e) {
      if (handlePrismaError(e, res)) return;
      throw e;
    }
  }),
);

router.delete(
  "/:projectId",
  requireAccess("ADMIN", (req) => ({ kind: "project", projectId: req.params.projectId! })),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId!;
    const docs = await db.document.findMany({
      where: { projectId },
      select: { storageKey: true, thumbnailKey: true, bundleKey: true },
    });
    const urls: Array<string | null> = [];
    for (const d of docs) {
      urls.push(d.storageKey ?? null, d.thumbnailKey ?? null, d.bundleKey ?? null);
    }
    await deleteByUrls(urls);
    await db.project.delete({ where: { id: projectId } });
    res.json({ ok: true });
  }),
);

router.get(
  "/:projectId/members",
  requireAccess("REVIEWER", (req) => ({ kind: "project", projectId: req.params.projectId! })),
  asyncHandler(async (req, res) => {
    const rows = await db.projectMember.findMany({
      where: { projectId: req.params.projectId! },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      orderBy: { joinedAt: "asc" },
    });
    res.json(rows);
  }),
);

router.post(
  "/:projectId/members/invite",
  requireAccess("ADMIN", (req) => ({ kind: "project", projectId: req.params.projectId! })),
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, inviteSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [invite, project, inviter] = await Promise.all([
      db.invite.create({
        data: {
          email: parsed.data.email,
          scopeType: "PROJECT",
          scopeId: req.params.projectId!,
          role: parsed.data.role,
          token,
          expiresAt,
          invitedBy: req.userId!,
        },
      }),
      db.project.findUniqueOrThrow({ where: { id: req.params.projectId! } }),
      db.user.findUniqueOrThrow({ where: { id: req.userId! } }),
    ]);
    const acceptUrl = `${process.env.APP_URL}/invite/${token}`;
    const email = await sendEmail({
      to: parsed.data.email,
      subject: `${inviter.name} invited you to ${project.name}`,
      html: inviteEmailHtml({ inviterName: inviter.name, scopeLabel: project.name, acceptUrl }),
    });
    res.status(201).json({ id: invite.id, email: invite.email, email_status: email });
  }),
);

router.patch(
  "/:projectId/members/:userId",
  requireAccess("ADMIN", (req) => ({ kind: "project", projectId: req.params.projectId! })),
  asyncHandler(async (req, res) => {
    const targetUserId = req.params.userId!;
    if (targetUserId === req.userId!) {
      return sendError(res, "SELF_FORBIDDEN", "You cannot change your own role", 409);
    }
    const parsed = parseBody(req.body, patchMemberSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const updated = await db.projectMember.update({
      where: { userId_projectId: { userId: targetUserId, projectId: req.params.projectId! } },
      data: { role: parsed.data.role },
    });
    res.json(updated);
  }),
);

router.delete(
  "/:projectId/members/:userId",
  requireAccess("ADMIN", (req) => ({ kind: "project", projectId: req.params.projectId! })),
  asyncHandler(async (req, res) => {
    const targetUserId = req.params.userId!;
    if (targetUserId === req.userId!) {
      return sendError(res, "SELF_FORBIDDEN", "You cannot remove yourself", 409);
    }
    const admins = await db.projectMember.count({
      where: { projectId: req.params.projectId!, role: "ADMIN" },
    });
    const target = await db.projectMember.findUnique({
      where: { userId_projectId: { userId: targetUserId, projectId: req.params.projectId! } },
    });
    if (target?.role === "ADMIN" && admins <= 1) {
      return sendError(res, "LAST_ADMIN", "Cannot remove the last project admin", 409);
    }
    await db.projectMember.delete({
      where: { userId_projectId: { userId: targetUserId, projectId: req.params.projectId! } },
    });
    res.json({ ok: true });
  }),
);

export default router;
