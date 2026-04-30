import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

let prisma: PrismaClient | null = null;
let testUrl: string | null = null;

function readDevUrl(): string {
  const envFile = fs.readFileSync(".env.local", "utf8");
  const match = envFile.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  if (!match || !match[1]) throw new Error("DATABASE_URL not found in .env.local");
  return match[1];
}

function deriveTestUrl(devUrl: string): string {
  const u = new URL(devUrl);
  const dbName = (u.pathname.replace(/^\//, "") || "pinion") + "_test";
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function setupDb(): Promise<PrismaClient> {
  if (prisma) return prisma;
  const dev = readDevUrl();
  testUrl = deriveTestUrl(dev);
  execSync("npx prisma db push --skip-generate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testUrl },
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
  return prisma;
}

export async function teardownDb() {
  if (prisma) await prisma.$disconnect();
  prisma = null;
  testUrl = null;
}

export async function resetDb(p: PrismaClient) {
  // Sequential order: delete children before parents to satisfy required relations
  // (Mongo doesn't cascade; Prisma enforces required-relation Restrict on delete).
  await p.folderMember.deleteMany();
  await p.projectMember.deleteMany();
  await p.orgMember.deleteMany();
  await p.folder.deleteMany();
  await p.project.deleteMany();
  await p.invite.deleteMany();
  await p.passwordReset.deleteMany();
  await p.session.deleteMany();
  await p.account.deleteMany();
  await p.verificationToken.deleteMany();
  await p.organization.deleteMany(); // must come before user (owner FK)
  await p.user.deleteMany();
}
