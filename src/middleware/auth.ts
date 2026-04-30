import type { Request, Response, NextFunction } from "express";
import { decode } from "@auth/core/jwt";
import { sendError } from "@/lib/api";
import { resolveAccess, roleMeets, type AccessScope } from "@/lib/access";
import type { Role } from "@/db";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// Auth.js v5 cookie names. Salt for decode() must match the cookie name.
const COOKIES: Array<{ name: string; secure: boolean }> = [
  { name: "authjs.session-token", secure: false },
  { name: "__Secure-authjs.session-token", secure: true },
  { name: "next-auth.session-token", secure: false },
  { name: "__Secure-next-auth.session-token", secure: true },
];

function findCookie(req: Request): { value: string; salt: string } | null {
  for (const c of COOKIES) {
    const v = req.cookies?.[c.name];
    if (v) return { value: v, salt: c.name };
  }
  return null;
}

export async function getUserId(req: Request): Promise<string | null> {
  const cookie = findCookie(req);
  if (!cookie) return null;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error("[api auth] NEXTAUTH_SECRET not set");
    return null;
  }
  try {
    const payload = await decode({
      token: cookie.value,
      secret,
      salt: cookie.salt,
    });
    if (!payload) return null;
    // JWT callback in web puts the user id as `uid`.
    const uid = (payload as { uid?: string; sub?: string }).uid ?? (payload as { sub?: string }).sub;
    return uid ?? null;
  } catch (err) {
    console.warn("[api auth] token decode failed:", (err as Error).message);
    return null;
  }
}

export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    req.userId = userId;
    next();
  };
}

export function requireAccess(
  required: Role,
  scopeFromReq: (req: Request) => AccessScope,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = await getUserId(req);
    if (!userId) return sendError(res, "UNAUTHORIZED", "Not authenticated", 401);
    const scope = scopeFromReq(req);
    const role = await resolveAccess(userId, scope);
    if (!role || !roleMeets(role, required)) {
      return sendError(res, "FORBIDDEN", "Access denied", 403);
    }
    req.userId = userId;
    next();
  };
}
