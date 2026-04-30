import type { Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { Prisma } from "@/db";

export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };

export function sendError(res: Response, code: string, message: string, status = 400, details?: unknown) {
  return res.status(status).json({ error: { code, message, details } });
}

export function parseBody<T extends z.ZodTypeAny>(
  body: unknown,
  schema: T,
): { ok: true; data: z.infer<T> } | { ok: false; details: unknown } {
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, details: parsed.error.flatten() };
  return { ok: true, data: parsed.data };
}

export function handlePrismaError(e: unknown, res: Response): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") {
      const target = (e.meta?.target as string[] | undefined)?.join(", ") ?? "field";
      sendError(res, "UNIQUE_VIOLATION", `Already taken: ${target}`, 409);
      return true;
    }
    if (e.code === "P2025") {
      sendError(res, "NOT_FOUND", "Record not found", 404);
      return true;
    }
  }
  if (e instanceof ZodError) {
    sendError(res, "VALIDATION_FAILED", "Invalid data", 422, e.flatten());
    return true;
  }
  return false;
}

export function asyncHandler(
  fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: any, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
