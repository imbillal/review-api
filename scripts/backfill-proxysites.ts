import "dotenv/config";
import { db } from "@/db";
import { validateProxyTarget } from "@/lib/ssrf";
import { generateSubdomain } from "@/lib/subdomain";

declare const process: { exit(code?: number): never };

/**
 * Backfill ProxySite registry rows for website documents created before the
 * live-subdomain-proxy feature shipped. Mirrors the allocation done by
 * POST /documents/website (see src/routes/documents.ts). Idempotent: a
 * document that already has a ProxySite row is skipped.
 */
async function main() {
  const websiteDocs = await db.document.findMany({
    where: { type: "WEBSITE" },
    select: { id: true, sourceUrl: true, deletedAt: true },
  });

  let created = 0;
  let alreadyExisted = 0;
  let skippedInvalid = 0;

  for (const doc of websiteDocs) {
    const existing = await db.proxySite.findUnique({
      where: { documentId: doc.id },
    });
    if (existing) {
      alreadyExisted++;
      continue;
    }
    if (!doc.sourceUrl) {
      skippedInvalid++;
      console.warn(`skip ${doc.id}: no sourceUrl`);
      continue;
    }
    const target = validateProxyTarget(doc.sourceUrl);
    if (!target.ok) {
      skippedInvalid++;
      console.warn(`skip ${doc.id}: ${target.reason} (${doc.sourceUrl})`);
      continue;
    }
    await db.proxySite.create({
      data: {
        documentId: doc.id,
        subdomain: generateSubdomain(),
        targetOrigin: target.origin,
        enabled: !doc.deletedAt,
      },
    });
    created++;
  }

  console.log(
    `Backfill ProxySite: created ${created}, already-existed ${alreadyExisted}, ` +
      `skipped-invalid ${skippedInvalid}, total website documents ${websiteDocs.length}`,
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
