import "dotenv/config";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import auth from "@/routes/auth";
import orgs from "@/routes/orgs";
import projects from "@/routes/projects";
import invites from "@/routes/invites";
import documents from "@/routes/documents";
import comments from "@/routes/comments";
import notifications from "@/routes/notifications";
import notificationPrefs from "@/routes/notification-prefs";
import proxy from "@/routes/proxy";
import render from "@/routes/render";

const WEB_ORIGIN_RAW = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const allowedOrigins = WEB_ORIGIN_RAW.split(",").map((s) => s.trim()).filter(Boolean);

export function createApp(): Express {
  const app = express();

  app.use(
    cors({
      origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.originalUrl}`);
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "pinion-api" });
  });

  app.use("/auth", auth);
  app.use("/orgs", orgs);
  app.use("/projects", projects);
  app.use("/invites", invites);
  app.use("/documents", documents);
  app.use("/comments", comments);
  app.use("/notifications", notifications);
  app.use("/notification-prefs", notificationPrefs);
  app.use("/proxy", proxy);
  app.use("/render", render);

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` } });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api error]", err);
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong" } });
  });

  return app;
}

const app = createApp();
export default app;
