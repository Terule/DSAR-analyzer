import { getCaseKey } from "../../src/lib/format";
import { insertCaseHistorySnapshots } from "../../src/lib/history";
import { prisma } from "../../src/lib/prisma";

type StatusRow = {
  id: string;
  filepath: string | null;
  kind: string;
  status: string;
  ai_status: string;
  pdf_status: string;
  files_status: string;
};

function isRowFinished(row: StatusRow): boolean {
  if (row.kind === "files") {
    return row.files_status === "completed" || row.files_status === "failed";
  }

  return (
    (row.status === "completed" || row.status === "failed") &&
    (row.ai_status === "completed" || row.ai_status === "failed") &&
    (row.pdf_status === "completed" || row.pdf_status === "failed")
  );
}

async function main() {
  const rows: StatusRow[] = await prisma.processedFile.findMany({
    select: {
      id: true,
      filepath: true,
      kind: true,
      status: true,
      ai_status: true,
      pdf_status: true,
      files_status: true,
    },
    orderBy: { created_at: "desc" },
  });

  const byCase = new Map<string, StatusRow[]>();
  for (const row of rows) {
    const caseKey = getCaseKey(row.filepath || "");
    const existing = byCase.get(caseKey) || [];
    existing.push(row);
    byCase.set(caseKey, existing);
  }

  const finishedCaseRows = [...byCase.values()].filter(
    (caseRows) => caseRows.length > 0 && caseRows.every(isRowFinished),
  );

  const finishedIds = finishedCaseRows.flatMap((caseRows) =>
    caseRows.map((row) => row.id),
  );

  const inserted = await insertCaseHistorySnapshots(
    finishedIds,
    "manual_reset",
  );

  console.log(
    JSON.stringify(
      {
        finishedCases: finishedCaseRows.length,
        finishedRows: finishedIds.length,
        insertedCaseSnapshots: inserted,
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
