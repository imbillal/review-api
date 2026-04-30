import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { setupDb, teardownDb, resetDb } from "./setup";
import { POST as signup } from "@/app/api/signup/route";

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = await setupDb();
}, 120_000);
afterAll(async () => {
  await teardownDb();
});
beforeEach(async () => {
  await resetDb(prisma);
});

function req(body: unknown) {
  return new Request("http://localhost/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/signup", () => {
  it("creates user and default org", async () => {
    const res = await signup(req({ email: "a@b.com", name: "Alice Smith", password: "password1" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.orgSlug).toMatch(/^alice-workspace/);
    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    const orgs = await prisma.organization.findMany({ include: { members: true } });
    expect(orgs).toHaveLength(1);
    expect(orgs[0].members).toHaveLength(1);
    expect(orgs[0].members[0].role).toBe("ADMIN");
  });

  it("rejects duplicate email", async () => {
    await signup(req({ email: "a@b.com", name: "A", password: "password1" }));
    const res = await signup(req({ email: "a@b.com", name: "B", password: "password1" }));
    expect(res.status).toBe(409);
  });

  it("dedupes slugs for same name", async () => {
    await signup(req({ email: "a@b.com", name: "Alice", password: "password1" }));
    const res = await signup(req({ email: "a2@b.com", name: "Alice", password: "password1" }));
    const data = await res.json();
    expect(data.orgSlug).toMatch(/-2$/);
  });

  it("rejects short password", async () => {
    const res = await signup(req({ email: "a@b.com", name: "A", password: "short" }));
    expect(res.status).toBe(422);
  });
});
