import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { sendError, parseBody, asyncHandler } from "@/lib/api";
import { getUserId, requireAuth } from "@/middleware/auth";
import { resolveAccess } from "@/lib/access";
import { generateToken } from "@/lib/tokens";
import { sendEmail } from "@/lib/email";

const router: Router = Router();

const EXPIRY_MAP: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const createSchema = z.object({
  projectId: z.string().optional(),
  documentId: z.string().optional(),
  expiresIn: z.enum(["1h", "24h", "7d", "30d"]).optional(),
  maxUses: z.number().int().positive().max(10000).optional(),
  allowComments: z.boolean().optional(),
  password: z.string().min(4).max(100).optional(),
  accessControl: z.enum(["ANYONE", "SPECIFIC", "CUSTOM"]).optional(),
});

const updateSchema = z.object({
  allowComments: z.boolean().optional(),
  expiresIn: z.enum(["1h", "24h", "7d", "30d"]).nullable().optional(),
  maxUses: z.number().int().positive().max(10000).nullable().optional(),
  password: z.string().min(4).max(100).nullable().optional(),
  accessControl: z.enum(["ANYONE", "SPECIFIC", "CUSTOM"]).optional(),
});

const inviteSchema = z.object({
  email: z.string().email().toLowerCase(),
  message: z.string().max(500).optional(),
});

const validateSchema = z.object({
  token: z.string().min(1),
  password: z.string().optional(),
});

function shareUrlFor(token: string): string {
  const base = process.env.FRONTEND_URL ?? "http://localhost:3000";
  return `${base}/guest?token=${encodeURIComponent(token)}`;
}

function publicLink(link: {
  id: string;
  token: string;
  projectId: string;
  documentId: string | null;
  passwordHash: string | null;
  expiresAt: Date | null;
  maxUses: number | null;
  usesCount: number;
  allowComments: boolean;
  accessControl: string;
  createdAt: Date;
}) {
  return {
    id: link.id,
    token: link.token,
    projectId: link.projectId,
    documentId: link.documentId,
    shareUrl: shareUrlFor(link.token),
    hasPassword: !!link.passwordHash,
    expiresAt: link.expiresAt,
    maxUses: link.maxUses,
    usesCount: link.usesCount,
    allowComments: link.allowComments,
    accessControl: link.accessControl,
    createdAt: link.createdAt,
  };
}

router.post(
  "/",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const parsed = parseBody(req.body, createSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    let projectId: string;
    let documentId: string | null = null;

    if (parsed.data.documentId) {
      const doc = await db.document.findUnique({ where: { id: parsed.data.documentId } });
      if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Document not found", 404);
      const role = await resolveAccess(userId, { kind: "document", documentId: doc.id });
      if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);
      projectId = doc.projectId;
      documentId = doc.id;
    } else if (parsed.data.projectId) {
      const role = await resolveAccess(userId, { kind: "project", projectId: parsed.data.projectId });
      if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);
      projectId = parsed.data.projectId;
    } else {
      return sendError(res, "MISSING_PARAM", "projectId or documentId required", 400);
    }

    const expiresAt = parsed.data.expiresIn
      ? new Date(Date.now() + EXPIRY_MAP[parsed.data.expiresIn]!)
      : null;
    const passwordHash = parsed.data.password
      ? await bcrypt.hash(parsed.data.password, 10)
      : null;

    const link = await db.guestLink.create({
      data: {
        projectId,
        documentId,
        token: generateToken(),
        passwordHash,
        expiresAt,
        maxUses: parsed.data.maxUses ?? null,
        allowComments: parsed.data.allowComments ?? true,
        accessControl: parsed.data.accessControl ?? "ANYONE",
        createdById: userId,
      },
    });

    res.status(201).json(publicLink(link));
  }),
);

router.get(
  "/",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const documentId = typeof req.query.documentId === "string" ? req.query.documentId : null;

    if (documentId) {
      const doc = await db.document.findUnique({ where: { id: documentId } });
      if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Document not found", 404);
      const role = await resolveAccess(userId, { kind: "document", documentId });
      if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);
      const links = await db.guestLink.findMany({
        where: { documentId },
        orderBy: { createdAt: "desc" },
      });
      return res.json(links.map(publicLink));
    }

    if (projectId) {
      const role = await resolveAccess(userId, { kind: "project", projectId });
      if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);
      const links = await db.guestLink.findMany({
        where: { projectId, documentId: null },
        orderBy: { createdAt: "desc" },
      });
      return res.json(links.map(publicLink));
    }

    return sendError(res, "MISSING_PARAM", "projectId or documentId required", 400);
  }),
);

router.patch(
  "/:linkId",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const link = await db.guestLink.findUnique({ where: { id: req.params.linkId! } });
    if (!link) return sendError(res, "NOT_FOUND", "Link not found", 404);

    const role = await resolveAccess(userId, { kind: "project", projectId: link.projectId });
    if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);

    const parsed = parseBody(req.body, updateSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    const data: {
      allowComments?: boolean;
      expiresAt?: Date | null;
      maxUses?: number | null;
      passwordHash?: string | null;
      accessControl?: string;
    } = {};
    if (parsed.data.allowComments !== undefined) data.allowComments = parsed.data.allowComments;
    if (parsed.data.expiresIn !== undefined) {
      data.expiresAt = parsed.data.expiresIn
        ? new Date(Date.now() + EXPIRY_MAP[parsed.data.expiresIn]!)
        : null;
    }
    if (parsed.data.maxUses !== undefined) data.maxUses = parsed.data.maxUses;
    if (parsed.data.password !== undefined) {
      data.passwordHash = parsed.data.password ? await bcrypt.hash(parsed.data.password, 10) : null;
    }
    if (parsed.data.accessControl !== undefined) data.accessControl = parsed.data.accessControl;

    const updated = await db.guestLink.update({ where: { id: link.id }, data });
    res.json(publicLink(updated));
  }),
);

router.delete(
  "/:linkId",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const link = await db.guestLink.findUnique({ where: { id: req.params.linkId! } });
    if (!link) return sendError(res, "NOT_FOUND", "Link not found", 404);

    const role = await resolveAccess(userId, { kind: "project", projectId: link.projectId });
    if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);

    await db.guestLink.delete({ where: { id: link.id } });
    res.json({ ok: true });
  }),
);

router.post(
  "/:linkId/invite",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const link = await db.guestLink.findUnique({ where: { id: req.params.linkId! } });
    if (!link) return sendError(res, "NOT_FOUND", "Link not found", 404);

    const role = await resolveAccess(userId, { kind: "project", projectId: link.projectId });
    if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);

    const parsed = parseBody(req.body, inviteSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    const project = await db.project.findUnique({ where: { id: link.projectId } });
    const inviter = await db.user.findUnique({ where: { id: userId }, select: { name: true } });

    const url = shareUrlFor(link.token);
    const html = `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px">You're invited to review</h2>
        <p>${inviter?.name ?? "Someone"} invited you to review <b>${project?.name ?? "a project"}</b> on Pinion.</p>
        ${parsed.data.message ? `<p style="background:#f5f5f5;padding:12px;border-radius:6px;">${parsed.data.message.replace(/[<>]/g, "")}</p>` : ""}
        <p><a href="${url}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open review</a></p>
        <p style="color:#666;font-size:12px;margin-top:24px">If you weren't expecting this, you can ignore this email.</p>
      </div>
    `;

    const result = await sendEmail({
      to: parsed.data.email,
      subject: `${inviter?.name ?? "Someone"} shared "${project?.name ?? "a project"}" with you`,
      html,
    });

    res.json({ ok: true, email: parsed.data.email, status: result.status });
  }),
);

router.post(
  "/validate",
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, validateSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    const link = await db.guestLink.findUnique({ where: { token: parsed.data.token } });
    if (!link) return sendError(res, "INVALID_TOKEN", "Invalid guest link", 404);

    if (link.expiresAt && new Date() > link.expiresAt) {
      return sendError(res, "EXPIRED", "Guest link has expired", 410);
    }
    if (link.maxUses != null && link.usesCount >= link.maxUses) {
      return sendError(res, "MAX_USES", "Guest link usage limit reached", 410);
    }
    if (link.passwordHash) {
      if (!parsed.data.password) {
        return res.status(401).json({ requiresPassword: true });
      }
      const ok = await bcrypt.compare(parsed.data.password, link.passwordHash);
      if (!ok) return sendError(res, "INVALID_PASSWORD", "Incorrect password", 401);
    }

    const project = await db.project.findUnique({
      where: { id: link.projectId },
      select: { id: true, name: true, slug: true },
    });
    if (!project) return sendError(res, "NOT_FOUND", "Project not found", 404);

    let document: { id: string; title: string } | null = null;
    if (link.documentId) {
      const doc = await db.document.findUnique({
        where: { id: link.documentId },
        select: { id: true, title: true },
      });
      document = doc;
    }

    res.json({
      project,
      document,
      allowComments: link.allowComments,
      hasPassword: !!link.passwordHash,
    });
  }),
);

export default router;

export async function authenticateGuestToken(
  token: string,
  password?: string,
): Promise<
  | {
      ok: true;
      link: {
        id: string;
        projectId: string;
        documentId: string | null;
        allowComments: boolean;
        usesCount: number;
        maxUses: number | null;
      };
    }
  | { ok: false; code: "INVALID_TOKEN" | "EXPIRED" | "MAX_USES" | "INVALID_PASSWORD" | "REQUIRES_PASSWORD" }
> {
  const link = await db.guestLink.findUnique({ where: { token } });
  if (!link) return { ok: false, code: "INVALID_TOKEN" };
  if (link.expiresAt && new Date() > link.expiresAt) return { ok: false, code: "EXPIRED" };
  if (link.maxUses != null && link.usesCount >= link.maxUses) return { ok: false, code: "MAX_USES" };
  if (link.passwordHash) {
    if (!password) return { ok: false, code: "REQUIRES_PASSWORD" };
    const valid = await bcrypt.compare(password, link.passwordHash);
    if (!valid) return { ok: false, code: "INVALID_PASSWORD" };
  }
  return {
    ok: true,
    link: {
      id: link.id,
      projectId: link.projectId,
      documentId: link.documentId,
      allowComments: link.allowComments,
      usesCount: link.usesCount,
      maxUses: link.maxUses,
    },
  };
}

export async function incrementGuestUses(linkId: string): Promise<void> {
  await db.guestLink.update({
    where: { id: linkId },
    data: { usesCount: { increment: 1 } },
  });
}
