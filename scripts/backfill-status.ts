import "dotenv/config";
import { db } from "@/db";

declare const process: { exit(code?: number): never };

async function main() {
  const projects = (await db.$runCommandRaw({
    update: "Project",
    updates: [
      {
        q: { status: { $exists: false } },
        u: { $set: { status: "TODO" } },
        multi: true,
      },
    ],
  })) as { nModified?: number; n?: number };

  const docs = (await db.$runCommandRaw({
    update: "Document",
    updates: [
      {
        q: { status: { $exists: false } },
        u: { $set: { status: "TODO" } },
        multi: true,
      },
    ],
  })) as { nModified?: number; n?: number };

  console.log(
    `Backfilled status: ${projects.nModified ?? 0} projects, ${docs.nModified ?? 0} documents`,
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
