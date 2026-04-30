import type { Request, Response, NextFunction } from "express";
import { sendError } from "@/lib/api";
import { resolveAccess, roleMeets, type AccessScope } from "@/lib/access";
import type { Role } from "@/db";
import { verifyAuthToken } from "@/lib/jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

function getBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim();
}

export async function getUserId(req: Request): Promise<string | null> {
  const token = getBearer(req);
  if (!token) return null;
  const payload = verifyAuthToken(token);
  return payload?.sub ?? null;
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
