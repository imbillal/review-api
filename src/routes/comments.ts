import { Router } from "express";
import { z } from "zod";
import { db } from "@/db";
import { sendError, parseBody, asyncHandler } from "@/lib/api";
import { getUserId } from "@/middleware/auth";
import { resolveAccess } from "@/lib/access";
import { notifyComment } from "@/lib/notify";
import { authenticateGuestToken, incrementGuestUses } from "@/routes/guest-links";

const router: Router = Router();

const createSchema = z.object({
  documentId: z.string(),
  body: z.string().min(1).max(40_000),
  attachmentUrl: z.string().max(2_000_000).optional(),
  viewportWidth: z.number().int().optional(),
  viewportHeight: z.number().int().optional(),
  xPct: z.number().min(0).max(100).optional(),
  yPct: z.number().min(0).max(100).optional(),
  pageIndex: z.number().int().min(0).optional(),
  threadId: z.string().optional(),
  elementSelector: z.string().optional(),
  elementPath: z.string().optional(),
  textFingerprint: z.string().optional(),
  pageUrl: z.string().max(500).optional(),
  guestName: z.string().min(1).max(80).optional(),
  guestEmail: z.string().email().max(200).optional(),
});

const patchSchema = z.object({
  body: z.string().min(1).max(40_000).optional(),
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
});

async function authDoc(userId: string, documentId: string) {
  const doc = await db.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.deletedAt) return { error: "NOT_FOUND" as const };
  const role = await resolveAccess(userId, { kind: "document", documentId: doc.id });
  if (!role) return { error: "FORBIDDEN" as const };
  return { doc, role };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    const guestToken = typeof req.query.guestToken === "string" ? req.query.guestToken : null;
    const guestPassword = typeof req.query.guestPassword === "string" ? req.query.guestPassword : undefined;
    const documentId = typeof req.query.documentId === "string" ? req.query.documentId : null;
    if (!documentId) return sendError(res, "MISSING_PARAM", "documentId required", 400);

    if (userId) {
      const check = await authDoc(userId, documentId);
      if ("error" in check) {
        if (check.error === "NOT_FOUND") return sendError(res, "NOT_FOUND", "Not found", 404);
        return sendError(res, "FORBIDDEN", "Access denied", 403);
      }
    } else if (guestToken) {
      const auth = await authenticateGuestToken(guestToken, guestPassword);
      if (!auth.ok) return sendError(res, auth.code, "Guest access denied", 401);
      const doc = await db.document.findUnique({ where: { id: documentId } });
      if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Not found", 404);
      if (auth.link.documentId) {
        if (auth.link.documentId !== doc.id) {
          return sendError(res, "FORBIDDEN", "Document not shared by this link", 403);
        }
      } else if (doc.projectId !== auth.link.projectId) {
        return sendError(res, "FORBIDDEN", "Document not in shared project", 403);
      }
    } else {
      return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    }

    const comments = await db.comment.findMany({
      where: { documentId },
      orderBy: [{ threadId: "asc" }, { createdAt: "asc" }],
    });
    const visible = comments.filter((c) => c.deletedAt == null);
    const realAuthorIds = Array.from(
      new Set(visible.map((c) => c.authorId).filter((id) => !id.startsWith("guest:"))),
    );
    const users = realAuthorIds.length
      ? await db.user.findMany({
          where: { id: { in: realAuthorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json(
      visible.map((c) => {
        if (c.authorId.startsWith("guest:")) {
          const meta = c.authorId.slice("guest:".length);
          const [name, email] = meta.split("|");
          return { ...c, author: { id: c.authorId, name: name || "Guest", email: email || null } };
        }
        return { ...c, author: byId.get(c.authorId) ?? null };
      }),
    );
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    const guestToken = typeof req.query.guestToken === "string" ? req.query.guestToken : null;
    const guestPassword = typeof req.query.guestPassword === "string" ? req.query.guestPassword : undefined;

    if (!userId && !guestToken) {
      return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    }

    const parsed = parseBody(req.body, createSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    let authorId: string;
    let authorRecord: { id: string; name: string; email: string | null } | null = null;
    let guestLinkId: string | null = null;

    if (userId) {
      const check = await authDoc(userId, parsed.data.documentId);
      if ("error" in check) {
        if (check.error === "NOT_FOUND") return sendError(res, "NOT_FOUND", "Not found", 404);
        return sendError(res, "FORBIDDEN", "Access denied", 403);
      }
      authorId = userId;
    } else {
      const auth = await authenticateGuestToken(guestToken!, guestPassword);
      if (!auth.ok) return sendError(res, auth.code, "Guest access denied", 401);
      if (!auth.link.allowComments) {
        return sendError(res, "COMMENTS_PAUSED", "Commenting is paused on this share link", 403);
      }
      const doc = await db.document.findUnique({ where: { id: parsed.data.documentId } });
      if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Not found", 404);
      if (auth.link.documentId) {
        if (auth.link.documentId !== doc.id) {
          return sendError(res, "FORBIDDEN", "Document not shared by this link", 403);
        }
      } else if (doc.projectId !== auth.link.projectId) {
        return sendError(res, "FORBIDDEN", "Document not in shared project", 403);
      }
      const guestName = (parsed.data.guestName ?? "Guest").replace(/\|/g, " ").slice(0, 80);
      const guestEmail = (parsed.data.guestEmail ?? "").replace(/\|/g, "").slice(0, 200);
      authorId = `guest:${guestName}|${guestEmail}`;
      authorRecord = { id: authorId, name: guestName, email: guestEmail || null };
      guestLinkId = auth.link.id;
    }

    const comment = await db.comment.create({
      data: {
        documentId: parsed.data.documentId,
        threadId: parsed.data.threadId ?? null,
        authorId,
        body: parsed.data.body,
        attachmentUrl: parsed.data.attachmentUrl ?? null,
        viewportWidth: parsed.data.viewportWidth ?? null,
        viewportHeight: parsed.data.viewportHeight ?? null,
        xPct: parsed.data.xPct ?? null,
        yPct: parsed.data.yPct ?? null,
        pageIndex: parsed.data.pageIndex ?? null,
        elementSelector: parsed.data.elementSelector ?? null,
        elementPath: parsed.data.elementPath ?? null,
        textFingerprint: parsed.data.textFingerprint ?? null,
        pageUrl: parsed.data.pageUrl ?? null,
      },
    });

    if (guestLinkId) {
      await incrementGuestUses(guestLinkId);
    }

    if (userId) {
      notifyComment({
        type: "COMMENT_CREATED",
        actorId: userId,
        comment: { id: comment.id, documentId: comment.documentId },
      }).catch((e) => console.error("[notify] create failed", e));
    }

    if (!authorRecord && userId) {
      authorRecord = await db.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });
    }

    res.status(201).json({ ...comment, author: authorRecord });
  }),
);

router.patch(
  "/:commentId",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const existing = await db.comment.findUnique({ where: { id: req.params.commentId! } });
    if (!existing || existing.deletedAt) return sendError(res, "NOT_FOUND", "Comment not found", 404);
    const check = await authDoc(userId, existing.documentId);
    if ("error" in check) {
      if (check.error === "NOT_FOUND") return sendError(res, "NOT_FOUND", "Not found", 404);
      return sendError(res, "FORBIDDEN", "Access denied", 403);
    }

    const parsed = parseBody(req.body, patchSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    if (parsed.data.body != null && existing.authorId !== userId) {
      return sendError(res, "FORBIDDEN", "Only the author can edit this comment", 403);
    }

    const data: {
      body?: string;
      status?: "OPEN" | "RESOLVED";
      editedAt?: Date;
      resolvedBy?: string | null;
      resolvedAt?: Date | null;
    } = {};
    if (parsed.data.body != null) {
      data.body = parsed.data.body;
      data.editedAt = new Date();
    }
    if (parsed.data.status != null) {
      data.status = parsed.data.status;
      if (parsed.data.status === "RESOLVED") {
        data.resolvedBy = userId;
        data.resolvedAt = new Date();
      } else {
        data.resolvedBy = null;
        data.resolvedAt = null;
      }
    }
    const updated = await db.comment.update({ where: { id: existing.id }, data });
    if (
      parsed.data.status === "RESOLVED" &&
      existing.status === "OPEN" &&
      updated.status === "RESOLVED"
    ) {
      notifyComment({
        type: "COMMENT_RESOLVED",
        actorId: userId,
        comment: { id: updated.id, documentId: updated.documentId },
      }).catch((e) => console.error("[notify] resolve failed", e));
    }
    let author: { id: string; name: string; email: string | null } | null = null;
    if (updated.authorId.startsWith("guest:")) {
      const meta = updated.authorId.slice("guest:".length);
      const [name, email] = meta.split("|");
      author = { id: updated.authorId, name: name || "Guest", email: email || null };
    } else {
      author = await db.user.findUnique({
        where: { id: updated.authorId },
        select: { id: true, name: true, email: true },
      });
    }
    res.json({ ...updated, author });
  }),
);

router.delete(
  "/:commentId",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const existing = await db.comment.findUnique({ where: { id: req.params.commentId! } });
    if (!existing || existing.deletedAt) return sendError(res, "NOT_FOUND", "Comment not found", 404);
    const check = await authDoc(userId, existing.documentId);
    if ("error" in check) {
      if (check.error === "NOT_FOUND") return sendError(res, "NOT_FOUND", "Not found", 404);
      return sendError(res, "FORBIDDEN", "Access denied", 403);
    }
    const isAuthor = existing.authorId === userId;
    const isAdmin = check.role === "ADMIN";
    if (!isAuthor && !isAdmin) {
      return sendError(res, "FORBIDDEN", "Only the author or an admin can delete", 403);
    }
    await db.comment.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
    res.json({ ok: true });
  }),
);

export default router;
