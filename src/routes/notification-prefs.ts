import { Router } from "express";
import { z } from "zod";
import { db } from "@/db";
import { sendError, parseBody, asyncHandler } from "@/lib/api";
import { getUserId } from "@/middleware/auth";
import { resolveAccess, roleMeets } from "@/lib/access";

const router: Router = Router();

const patchSchema = z.object({
  notifyOnCommentCreated: z.boolean().optional(),
  notifyOnCommentResolved: z.boolean().optional(),
});

router.get(
  "/:orgId",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const orgId = req.params.orgId!;
    const role = await resolveAccess(userId, { kind: "org", orgId });
    if (!roleMeets(role, "ADMIN")) return sendError(res, "FORBIDDEN", "Admin required", 403);

    const prefs = await db.notificationPreference.upsert({
      where: { userId_orgId: { userId, orgId } },
      update: {},
      create: { userId, orgId },
    });
    res.json(prefs);
  }),
);

router.patch(
  "/:orgId",
  asyncHandler(async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const orgId = req.params.orgId!;
    const role = await resolveAccess(userId, { kind: "org", orgId });
    if (!roleMeets(role, "ADMIN")) return sendError(res, "FORBIDDEN", "Admin required", 403);

    const parsed = parseBody(req.body, patchSchema);
    if (!parsed.ok) return sendError(res, "VALIDATION_FAILED", "Invalid body", 422, parsed.details);

    const updated = await db.notificationPreference.upsert({
      where: { userId_orgId: { userId, orgId } },
      update: parsed.data,
      create: { userId, orgId, ...parsed.data },
    });
    res.json(updated);
  }),
);

export default router;
