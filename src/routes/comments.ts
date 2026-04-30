import { Router } from "express";
import { z } from "zod";
import { db } from "@/db";
import { sendError, parseBody, asyncHandler } from "@/lib/api";
import { getUserId } from "@/middleware/auth";
import { resolveAccess } from "@/lib/access";
import { notifyComment } from "@/lib/notify";

const router: Router = Router();

const createSchema = z.object({
  documentId: z.string(),
  body: z.string().min(1).max(10_000),
  xPct: z.number().min(0).max(100).optional(),
  yPct: z.number().min(0).max(100).optional(),
  pageIndex: z.number().int().min(0).optional(),
  threadId: z.string().optional(),
  elementSelector: z.string().optional(),
  elementPath: z.string().optional(),
  textFingerprint: z.string().optional(),
  pageUrl: z.string().max(500).optional(),
});

const patchSchema = z.object({
  body: z.string().min(1).max(10_000).optional(),
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
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const documentId = typeof req.query.documentId === "string" ? req.query.documentId : null;
    if (!documentId) return sendError(res, "MISSING_PARAM", "documentId required", 400);
    const check = await authDoc(userId, documentId);
    if ("error" in check) {
      if (check.error === "NOT_FOUND") return sendError(res, "NOT_FOUND", "Not found", 404);
      return sendError(res, "FORBIDDEN", "Access denied", 403);
    }
    const comments = await db.comment.findMany({
      where: { documentId },
      orderBy: [{ threadId: "asc" }, { createdAt: "asc" }],
    });
    const visible = comments.filter((c) => c.deletedAt == null);
    const authorIds = Array.from(new Set(visible.map((c) => c.authorId)));
    const users = authorIds.length
      ? await db.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json(visible.map((c) => ({ ...c, author: byId.get(c.authorId) ?? null })));
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const parsed = parseBody(req.body, createSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const check = await authDoc(userId, parsed.data.documentId);
    if ("error" in check) {
      if (check.error === "NOT_FOUND") return sendError(res, "NOT_FOUND", "Not found", 404);
      return sendError(res, "FORBIDDEN", "Access denied", 403);
    }

    const comment = await db.comment.create({
      data: {
        documentId: parsed.data.documentId,
        threadId: parsed.data.threadId ?? null,
        authorId: userId,
        body: parsed.data.body,
        xPct: parsed.data.xPct ?? null,
        yPct: parsed.data.yPct ?? null,
        pageIndex: parsed.data.pageIndex ?? null,
        elementSelector: parsed.data.elementSelector ?? null,
        elementPath: parsed.data.elementPath ?? null,
        textFingerprint: parsed.data.textFingerprint ?? null,
        pageUrl: parsed.data.pageUrl ?? null,
      },
    });
    notifyComment({
      type: "COMMENT_CREATED",
      actorId: userId,
      comment: { id: comment.id, documentId: comment.documentId },
    }).catch((e) => console.error("[notify] create failed", e));
    const author = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });
    res.status(201).json({ ...comment, author });
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

    // Editing body: only author. Status change: author OR admin.
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
    const author = await db.user.findUnique({
      where: { id: updated.authorId },
      select: { id: true, name: true, email: true },
    });
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
