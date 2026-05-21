import { Router } from "express";
import { z } from "zod";
import { db } from "@/db";
import { sendError, parseBody, asyncHandler, handlePrismaError } from "@/lib/api";
import { requireAuth, getUserId } from "@/middleware/auth";
import {
  presignPut,
  publicUrlFor,
  objectExists,
  deleteByUrls,
} from "@/lib/storage";
import { captureUrl } from "@/lib/capture";
import { resolveAccess } from "@/lib/access";
import { generateToken } from "@/lib/tokens";
import { sendEmail, inviteEmailHtml } from "@/lib/email";
import { authenticateGuestToken } from "@/routes/guest-links";
import { validateProxyTarget } from "@/lib/ssrf";
import { generateSubdomain } from "@/lib/subdomain";

const router: Router = Router();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ACCEPTED_PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const IMAGE_EXTS = /\.(png|jpe?g|webp|gif)$/i;

const renameSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  projectId: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "COMPLETE"]).optional(),
});
const websiteSchema = z.object({
  projectId: z.string(),
  url: z.string().url(),
  title: z.string().min(1).max(200).optional(),
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
    const guestToken = typeof req.query.guestToken === "string" ? req.query.guestToken : null;
    const guestPassword = typeof req.query.guestPassword === "string" ? req.query.guestPassword : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    if (!projectId) return sendError(res, "MISSING_PARAM", "projectId required", 400);

    if (userId) {
      const role = await resolveAccess(userId, { kind: "project", projectId });
      if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);
    } else if (guestToken) {
      const auth = await authenticateGuestToken(guestToken, guestPassword);
      if (!auth.ok) return sendError(res, auth.code, "Guest access denied", 401);
      if (auth.link.projectId !== projectId) {
        return sendError(res, "FORBIDDEN", "Project not in shared link", 403);
      }
      if (auth.link.documentId) {
        const doc = await db.document.findUnique({ where: { id: auth.link.documentId } });
        if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Document not found", 404);
        const docComments = await db.comment.findMany({
          where: { documentId: doc.id },
          select: { status: true, deletedAt: true },
        });
        const counts = { open: 0, resolved: 0 };
        for (const c of docComments) {
          if (c.deletedAt != null) continue;
          if (c.status === "OPEN") counts.open += 1;
          else if (c.status === "RESOLVED") counts.resolved += 1;
        }
        return res.json([{ ...doc, commentCounts: counts }]);
      }
    } else {
      return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    }
    const rows = await db.document.findMany({
      where: {
        projectId,
        OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
      },
      orderBy: { createdAt: "desc" },
    });
    const docIds = rows.map((r) => r.id);
    // Prisma + Mongo quirk: `deletedAt: null` matches zero rows. Fetch then filter in JS.
    const comments = docIds.length
      ? await db.comment.findMany({
          where: { documentId: { in: docIds } },
          select: { documentId: true, status: true, deletedAt: true },
        })
      : [];
    const countMap = new Map<string, { open: number; resolved: number }>();
    for (const id of docIds) countMap.set(id, { open: 0, resolved: 0 });
    for (const c of comments) {
      if (c.deletedAt != null) continue;
      const entry = countMap.get(c.documentId)!;
      if (c.status === "OPEN") entry.open += 1;
      else if (c.status === "RESOLVED") entry.resolved += 1;
    }
    res.json(rows.map((r) => ({ ...r, commentCounts: countMap.get(r.id) ?? { open: 0, resolved: 0 } })));
  }),
);

// Step 1: client requests a presigned URL to PUT the file directly to S3.
const presignSchema = z.object({
  projectId: z.string().min(1),
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});
router.post(
  "/upload-presign",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, presignSchema);
    if (!parsed.ok)
      return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const { projectId, filename, contentType, sizeBytes } = parsed.data;

    const role = await resolveAccess(req.userId!, { kind: "project", projectId });
    if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);

    const isPdf = ACCEPTED_PDF_TYPES.has(contentType) || filename.toLowerCase().endsWith(".pdf");
    const isImage = ACCEPTED_IMAGE_TYPES.has(contentType) || IMAGE_EXTS.test(filename);
    if (!isPdf && !isImage) {
      return sendError(res, "WRONG_TYPE", "Only PDF and image files supported", 400);
    }
    if (sizeBytes > MAX_UPLOAD_BYTES) {
      return sendError(res, "TOO_LARGE", "File exceeds 50 MB", 413);
    }

    const presigned = await presignPut(`pinion/documents/${projectId}`, filename, contentType);
    res.json(presigned);
  }),
);

// Step 2: after the client successfully PUTs the file, finalize by creating
// the Document row. We HEAD-check the key first to make sure something is
// actually there.
const finalizeSchema = z.object({
  projectId: z.string().min(1),
  key: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  filename: z.string().min(1).max(200).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  mimeType: z.string().min(1).max(100).optional(),
  pageCount: z.number().int().positive().optional(),
});
router.post(
  "/upload-finalize",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, finalizeSchema);
    if (!parsed.ok)
      return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const { projectId, key, title, filename, sizeBytes, mimeType, pageCount } = parsed.data;

    const role = await resolveAccess(req.userId!, { kind: "project", projectId });
    if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);

    // Make sure the upload actually landed.
    if (!(await objectExists(key))) {
      return sendError(res, "UPLOAD_NOT_FOUND", "Uploaded object not found in storage", 400);
    }

    const isImage =
      (mimeType && ACCEPTED_IMAGE_TYPES.has(mimeType)) ||
      (filename && IMAGE_EXTS.test(filename));

    const finalTitle =
      (title && title.trim()) ||
      (filename ? filename.replace(/\.(pdf|png|jpe?g|webp|gif)$/i, "") : null) ||
      "Untitled";

    try {
      const doc = await db.document.create({
        data: {
          projectId,
          type: isImage ? "IMAGE" : "PDF",
          title: finalTitle,
          storageKey: publicUrlFor(key),
          mimeType: mimeType ?? (isImage ? "image/png" : "application/pdf"),
          sizeBytes: sizeBytes ?? null,
          pageCount: isImage ? 1 : (pageCount ?? null),
          snapshotStatus: "READY",
          createdById: req.userId!,
        },
      });
      res.status(201).json(doc);
    } catch (e) {
      if (handlePrismaError(e, res)) return;
      throw e;
    }
  }),
);

// Website capture endpoint: pastes a URL, captures, returns Document.
router.post(
  "/website",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, websiteSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const { projectId, url, title } = parsed.data;

    const target = validateProxyTarget(url);
    if (!target.ok) {
      return sendError(res, "INVALID_URL", target.reason, 422);
    }

    const role = await resolveAccess(req.userId!, { kind: "project", projectId });
    if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);

    const doc = await db.document.create({
      data: {
        projectId,
        type: "WEBSITE",
        title: title ?? url,
        sourceUrl: url,
        snapshotStatus: "PENDING",
        createdById: req.userId!,
      },
    });

    await db.proxySite.create({
      data: {
        documentId: doc.id,
        subdomain: generateSubdomain(),
        targetOrigin: target.origin,
      },
    });

    try {
      const result = await captureUrl(url);
      const updated = await db.document.update({
        where: { id: doc.id },
        data: {
          title: title ?? result.title,
          thumbnailKey: result.thumbnailUrl,
          viewportWidth: result.viewportWidth,
          viewportHeight: result.viewportHeight,
          snapshotStatus: "READY",
          lastCapturedAt: new Date(),
        },
      });
      res.status(201).json(updated);
    } catch (e) {
      const msg = (e as Error).message ?? "capture failed";
      console.error("[capture]", msg);
      await db.document.update({
        where: { id: doc.id },
        data: { snapshotStatus: "FAILED", captureError: msg },
      });
      return sendError(res, "CAPTURE_FAILED", msg, 500);
    }
  }),
);

router.post(
  "/:documentId/recapture",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const doc = await db.document.findUnique({ where: { id: req.params.documentId! } });
    if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Document not found", 404);
    if (doc.type !== "WEBSITE" || !doc.sourceUrl)
      return sendError(res, "WRONG_TYPE", "Not a website document", 400);
    const role = await resolveAccess(userId, { kind: "document", documentId: doc.id });
    if (role !== "ADMIN") return sendError(res, "FORBIDDEN", "Admin required", 403);

    await db.document.update({
      where: { id: doc.id },
      data: { snapshotStatus: "PENDING", captureError: null },
    });
    try {
      const result = await captureUrl(doc.sourceUrl);
      const updated = await db.document.update({
        where: { id: doc.id },
        data: {
          thumbnailKey: result.thumbnailUrl,
          snapshotStatus: "READY",
          lastCapturedAt: new Date(),
        },
      });
      res.json(updated);
    } catch (e) {
      const msg = (e as Error).message ?? "capture failed";
      await db.document.update({
        where: { id: doc.id },
        data: { snapshotStatus: "FAILED", captureError: msg },
      });
      return sendError(res, "CAPTURE_FAILED", msg, 500);
    }
  }),
);

router.get(
  "/:documentId",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    const guestToken = typeof req.query.guestToken === "string" ? req.query.guestToken : null;
    const guestPassword = typeof req.query.guestPassword === "string" ? req.query.guestPassword : undefined;
    const doc = await db.document.findUnique({ where: { id: req.params.documentId! } });
    if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Document not found", 404);

    let viewerRole: "ADMIN" | "REVIEWER" | null = null;
    if (userId) {
      const role = await resolveAccess(userId, { kind: "document", documentId: doc.id });
      if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);
      viewerRole = role;
    } else if (guestToken) {
      const auth = await authenticateGuestToken(guestToken, guestPassword);
      if (!auth.ok) return sendError(res, auth.code, "Guest access denied", 401);
      if (auth.link.documentId) {
        if (auth.link.documentId !== doc.id) {
          return sendError(res, "FORBIDDEN", "Document not shared by this link", 403);
        }
      } else if (auth.link.projectId !== doc.projectId) {
        return sendError(res, "FORBIDDEN", "Document not in shared project", 403);
      }
    } else {
      return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    }
    res.json({ ...doc, viewerRole });
  }),
);

router.patch(
  "/:documentId",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const doc = await db.document.findUnique({ where: { id: req.params.documentId! } });
    if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Document not found", 404);
    const role = await resolveAccess(userId, { kind: "document", documentId: doc.id });
    if (role !== "ADMIN") return sendError(res, "FORBIDDEN", "Only admins can edit documents", 403);

    const parsed = parseBody(req.body, renameSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    const data: { title?: string; projectId?: string; status?: "TODO" | "IN_PROGRESS" | "COMPLETE" } = {};
    if (parsed.data.title != null) data.title = parsed.data.title;
    if (parsed.data.status != null) data.status = parsed.data.status;
    if (parsed.data.projectId && parsed.data.projectId !== doc.projectId) {
      const targetRole = await resolveAccess(userId, {
        kind: "project",
        projectId: parsed.data.projectId,
      });
      if (targetRole !== "ADMIN") {
        return sendError(res, "FORBIDDEN", "Admin access to target project required", 403);
      }
      data.projectId = parsed.data.projectId;
    }
    const updated = await db.document.update({ where: { id: doc.id }, data });
    res.json(updated);
  }),
);

router.delete(
  "/:documentId",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const doc = await db.document.findUnique({ where: { id: req.params.documentId! } });
    if (!doc || doc.deletedAt) return sendError(res, "NOT_FOUND", "Document not found", 404);
    const role = await resolveAccess(userId, { kind: "document", documentId: doc.id });
    if (role !== "ADMIN") return sendError(res, "FORBIDDEN", "Only admins can delete", 403);

    const commentAttachments = await db.comment.findMany({
      where: { documentId: doc.id, attachmentUrl: { not: null } },
      select: { attachmentUrl: true },
    });
    await db.document.update({
      where: { id: doc.id },
      data: { deletedAt: new Date() },
    });
    await db.proxySite.updateMany({
      where: { documentId: doc.id },
      data: { enabled: false },
    });
    await deleteByUrls([
      doc.storageKey,
      doc.thumbnailKey,
      doc.bundleKey,
      ...commentAttachments.map((c) => c.attachmentUrl),
    ]);
    res.json({ ok: true });
  }),
);

// Per-document sharing: list/invite/remove members.
router.get(
  "/:documentId/members",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const docId = req.params.documentId!;
    const role = await resolveAccess(userId, { kind: "document", documentId: docId });
    if (!role) return sendError(res, "FORBIDDEN", "Access denied", 403);
    const members = await db.documentMember.findMany({
      where: { documentId: docId },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.json(members);
  }),
);

router.post(
  "/:documentId/members/invite",
  asyncHandler(async (req, res) => {
    const callerId = await getUserId(req);
    if (!callerId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const docId = req.params.documentId!;
    const role = await resolveAccess(callerId, { kind: "document", documentId: docId });
    if (role !== "ADMIN") return sendError(res, "FORBIDDEN", "Admin required", 403);

    const parsed = parseBody(req.body, inviteSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [invite, doc, inviter] = await Promise.all([
      db.invite.create({
        data: {
          email: parsed.data.email,
          scopeType: "DOCUMENT",
          scopeId: docId,
          role: parsed.data.role,
          token,
          expiresAt,
          invitedBy: callerId,
        },
      }),
      db.document.findUniqueOrThrow({ where: { id: docId } }),
      db.user.findUniqueOrThrow({ where: { id: callerId } }),
    ]);
    const acceptUrl = `${process.env.APP_URL}/invite/${token}`;
    const email = await sendEmail({
      to: parsed.data.email,
      subject: `${inviter.name} shared "${doc.title}" with you`,
      html: inviteEmailHtml({ inviterName: inviter.name, scopeLabel: doc.title, acceptUrl }),
    });
    res.status(201).json({ id: invite.id, email: invite.email, email_status: email });
  }),
);

router.patch(
  "/:documentId/members/:userId",
  asyncHandler(async (req, res) => {
    const callerId = await getUserId(req);
    if (!callerId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const docId = req.params.documentId!;
    const role = await resolveAccess(callerId, { kind: "document", documentId: docId });
    if (role !== "ADMIN") return sendError(res, "FORBIDDEN", "Admin required", 403);
    const targetUserId = req.params.userId!;
    if (targetUserId === callerId) {
      return sendError(res, "SELF_FORBIDDEN", "You cannot change your own role", 409);
    }
    const parsed = parseBody(req.body, patchMemberSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);
    const updated = await db.documentMember.update({
      where: { userId_documentId: { userId: targetUserId, documentId: docId } },
      data: { role: parsed.data.role },
    });
    res.json(updated);
  }),
);

router.delete(
  "/:documentId/members/:userId",
  asyncHandler(async (req, res) => {
    const callerId = await getUserId(req);
    if (!callerId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const docId = req.params.documentId!;
    const role = await resolveAccess(callerId, { kind: "document", documentId: docId });
    if (role !== "ADMIN") return sendError(res, "FORBIDDEN", "Admin required", 403);
    await db.documentMember.deleteMany({
      where: { documentId: docId, userId: req.params.userId! },
    });
    res.json({ ok: true });
  }),
);

export default router;
