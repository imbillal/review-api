import { db, type Role } from "@/db";

export type AccessScope =
  | { kind: "org"; orgId: string }
  | { kind: "project"; projectId: string }
  | { kind: "document"; documentId: string };

const ROLE_RANK: Record<Role, number> = { ADMIN: 2, REVIEWER: 1 };

export function resolveHighestRole(
  org: { role: Role } | null,
  project: { role: Role } | null,
  doc: { role: Role } | null,
): Role | null {
  const candidates = [org?.role, project?.role, doc?.role].filter(
    (r): r is Role => r != null,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => (ROLE_RANK[r] > ROLE_RANK[best] ? r : best));
}

export async function resolveAccess(
  userId: string,
  scope: AccessScope,
): Promise<Role | null> {
  let orgId: string | null = null;
  let projectId: string | null = null;
  let documentId: string | null = null;

  if (scope.kind === "document") {
    const doc = await db.document.findUnique({
      where: { id: scope.documentId },
      select: { id: true, projectId: true, project: { select: { orgId: true } } },
    });
    if (!doc) return null;
    documentId = doc.id;
    projectId = doc.projectId;
    orgId = doc.project.orgId;
  } else if (scope.kind === "project") {
    const project = await db.project.findUnique({
      where: { id: scope.projectId },
      select: { id: true, orgId: true },
    });
    if (!project) return null;
    projectId = project.id;
    orgId = project.orgId;
  } else {
    orgId = scope.orgId;
  }

  const [orgMem, projectMem, documentMem] = await Promise.all([
    orgId
      ? db.orgMember.findUnique({
          where: { userId_orgId: { userId, orgId } },
          select: { role: true },
        })
      : null,
    projectId
      ? db.projectMember.findUnique({
          where: { userId_projectId: { userId, projectId } },
          select: { role: true },
        })
      : null,
    documentId
      ? db.documentMember.findUnique({
          where: { userId_documentId: { userId, documentId } },
          select: { role: true },
        })
      : null,
  ]);

  return resolveHighestRole(orgMem, projectMem, documentMem);
}

export function roleMeets(actual: Role | null, required: Role): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
