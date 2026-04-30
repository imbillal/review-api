import fs from "node:fs";

try {
  const envFile = fs.readFileSync(".env.local", "utf8");
  const match = envFile.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  if (match && match[1]) {
    const u = new URL(match[1]);
    const dbName = (u.pathname.replace(/^\//, "") || "pinion") + "_test";
    u.pathname = `/${dbName}`;
    process.env.DATABASE_URL = u.toString();
  }
} catch {
  // .env.local absent (e.g. CI) — rely on env var already being set
}
