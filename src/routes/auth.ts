import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/db";
import { sendError, parseBody, handlePrismaError, asyncHandler } from "@/lib/api";
import { signAuthToken } from "@/lib/jwt";
import { requireAuth } from "@/middleware/auth";
import { slugify, ensureUniqueSlug } from "@/lib/slug";

const router: Router = Router();

const signupSchema = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

router.post(
  "/signup",
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, signupSchema);
    if (!parsed.ok)
      return sendError(res, "VALIDATION_FAILED", "Invalid data", 422, parsed.details);
    const { email, name, password } = parsed.data;

    const existing = await db.user.findUnique({ where: { email } });
    if (existing)
      return sendError(res, "EMAIL_TAKEN", "An account with that email already exists", 409);

    const passwordHash = await bcrypt.hash(password, 12);
    const firstName = name.split(" ")[0] ?? name;
    const workspaceBase = slugify(`${firstName}-workspace`);

    try {
      const result = await db.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email, name, passwordHash } });
        const slug = await ensureUniqueSlug(workspaceBase, async (s) => {
          const row = await tx.organization.findUnique({ where: { slug: s } });
          return row != null;
        });
        await tx.organization.create({
          data: {
            name: `${firstName}'s Workspace`,
            slug,
            ownerId: user.id,
            members: { create: { userId: user.id, role: "ADMIN" } },
          },
        });
        return { user, orgSlug: slug };
      });
      const token = signAuthToken({ sub: result.user.id, email: result.user.email });
      res.status(201).json({
        token,
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          avatarUrl: result.user.avatarUrl ?? null,
        },
        orgSlug: result.orgSlug,
      });
    } catch (e) {
      if (handlePrismaError(e, res)) return;
      throw e;
    }
  }),
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, loginSchema);
    if (!parsed.ok)
      return sendError(res, "VALIDATION_FAILED", "Invalid data", 422, parsed.details);
    const user = await db.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || !user.passwordHash)
      return sendError(res, "INVALID_CREDENTIALS", "Invalid email or password", 401);
    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok)
      return sendError(res, "INVALID_CREDENTIALS", "Invalid email or password", 401);
    const token = signAuthToken({ sub: user.id, email: user.email });
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl ?? null },
    });
  }),
);

router.get(
  "/me",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: req.userId! },
      select: { id: true, email: true, name: true, avatarUrl: true, passwordHash: true },
    });
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl ?? null,
      hasPassword: Boolean(user.passwordHash),
    });
  }),
);

router.post(
  "/logout",
  asyncHandler(async (_req, res) => {
    res.json({ ok: true });
  }),
);

const updateProfileSchema = z.object({ name: z.string().trim().min(1).max(120) });
router.patch(
  "/me",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, updateProfileSchema);
    if (!parsed.ok)
      return sendError(res, "VALIDATION_FAILED", "Invalid data", 422, parsed.details);
    try {
      const user = await db.user.update({
        where: { id: req.userId! },
        data: { name: parsed.data.name },
        select: { id: true, name: true, email: true, avatarUrl: true },
      });
      res.json(user);
    } catch (e) {
      if (handlePrismaError(e, res)) return;
      throw e;
    }
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});
router.post(
  "/change-password",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const parsed = parseBody(req.body, changePasswordSchema);
    if (!parsed.ok)
      return sendError(res, "VALIDATION_FAILED", "Invalid data", 422, parsed.details);
    const user = await db.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (!user.passwordHash)
      return sendError(res, "NO_PASSWORD", "Account has no password set", 400);
    const ok = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
    if (!ok)
      return sendError(res, "INVALID_CREDENTIALS", "Current password is incorrect", 401);
    const newHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await db.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    res.json({ ok: true });
  }),
);

export default router;
