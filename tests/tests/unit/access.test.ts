import { describe, expect, it } from "vitest";
import { resolveHighestRole } from "@/lib/access";
import type { Role } from "@prisma/client";

type M = { role: Role } | null;

describe("resolveHighestRole", () => {
  const cases: Array<{ name: string; org: M; project: M; folder: M; expected: Role | null }> = [
    { name: "none", org: null, project: null, folder: null, expected: null },
    { name: "only org reviewer", org: { role: "REVIEWER" }, project: null, folder: null, expected: "REVIEWER" },
    { name: "only folder admin", org: null, project: null, folder: { role: "ADMIN" }, expected: "ADMIN" },
    {
      name: "org reviewer + folder admin -> admin",
      org: { role: "REVIEWER" }, project: null, folder: { role: "ADMIN" }, expected: "ADMIN",
    },
    {
      name: "project admin + folder reviewer -> admin",
      org: null, project: { role: "ADMIN" }, folder: { role: "REVIEWER" }, expected: "ADMIN",
    },
    {
      name: "all reviewers -> reviewer",
      org: { role: "REVIEWER" }, project: { role: "REVIEWER" }, folder: { role: "REVIEWER" }, expected: "REVIEWER",
    },
    {
      name: "all admins -> admin",
      org: { role: "ADMIN" }, project: { role: "ADMIN" }, folder: { role: "ADMIN" }, expected: "ADMIN",
    },
  ];
  it.each(cases)("$name", ({ org, project, folder, expected }) => {
    expect(resolveHighestRole(org, project, folder)).toBe(expected);
  });
});
