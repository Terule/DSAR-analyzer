import { getCaseKey } from "../src/lib/format";
import { prisma } from "../src/lib/prisma";

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const caseKey = parseArg("--case") || parseArg("-c");
const requestKey = parseArg("--request") || parseArg("-r");
const key = caseKey
  ? requestKey
    ? `${caseKey}/${requestKey}`
    : caseKey
  : undefined;

if (!key) {
  console.error(
    "Usage: npm run reset:ai:case -- --case <CASE> [--request <REQUEST>]",
  );
  process.exit(1);
}

async function main() {
  const nonNullKey: string = key as string;
  const rows = await prisma.processedFile.findMany({
    select: { id: true, filepath: true, kind: true },
  });

  const targetPstIds = rows
    .filter(
      (row) =>
        row.kind !== "files" && getCaseKey(row.filepath || "") === nonNullKey,
    )
    .map((row) => row.id);

  if (targetPstIds.length === 0) {
    console.error(`No PST rows found for case key: ${nonNullKey}`);
    process.exit(1);
  }

  await prisma.$transaction([
    // Reset AI/PDF states so orchestration resumes from AI for these PST rows.
    prisma.processedFile.updateMany({
      where: { id: { in: targetPstIds } },
      data: {
        ai_status: "pending",
        ai_started_at: null,
        ai_duration_ms: 0,
        ai_batches_total: 0,
        ai_batches_done: 0,
        batch_id: null,
        ai_approved_count: 0,
        ai_discarded_count: 0,
        pdf_status: "pending",
        pdf_duration_ms: 0,
      },
    }),
    // Clear AI decisions only for emails tied to this case's PST rows.
    prisma.email.updateMany({
      where: { file_id: { in: targetPstIds } },
      data: { ai_decision: null, ai_reason: null },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        caseKey: nonNullKey,
        pstRowsReset: targetPstIds.length,
        message:
          "AI/PDF state reset for selected case. Re-run from UI to continue at AI phase.",
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
