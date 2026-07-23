import fs from "node:fs";
import path from "node:path";
import { getCaseKey } from "../src/lib/format";
import { prisma } from "../src/lib/prisma";
import { getPstWorkFolder } from "../src/lib/pst-artifacts";

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

  const coordinator = [...targetPstIds].sort()[0];
  const sourcePath = rows.find((row) => row.id === coordinator)?.filepath;
  if (!sourcePath) {
    throw new Error("AI reset could not resolve the request working folder.");
  }

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  const extractedPath =
    process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";
  const workingFolder = getPstWorkFolder({
    fileId: coordinator,
    filepath: sourcePath,
    stagingPath,
    extractedPath,
  });
  const uniqueEmailsFolder = path.join(workingFolder, ".unique-emails");

  // AI routes EMLs by moving them out of raw-emails. Return those artifacts
  // first, so an AI-only reset remains possible without re-running extraction.
  const rawEmailsFolder = path.join(uniqueEmailsFolder, "raw-emails");
  fs.mkdirSync(rawEmailsFolder, { recursive: true });
  for (const folder of ["selected", "discarded"]) {
    const sourceFolder = path.join(uniqueEmailsFolder, folder);
    if (!fs.existsSync(sourceFolder)) continue;
    for (const filename of fs.readdirSync(sourceFolder)) {
      if (!filename.toLowerCase().endsWith(".eml")) continue;
      const source = path.join(sourceFolder, filename);
      const target = path.join(rawEmailsFolder, filename);
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
    }
  }

  // Preserve Parse/Extract inputs (raw EMLs and JSON payloads), while removing
  // only outputs that the next AI pass will recreate.
  for (const folder of ["selected", "discarded"]) {
    fs.rmSync(path.join(uniqueEmailsFolder, folder), {
      recursive: true,
      force: true,
    });
  }
  fs.rmSync(path.join(path.dirname(path.dirname(workingFolder)), "Emails"), {
    recursive: true,
    force: true,
  });

  // These decisions are made before AI payload generation, and some have no
  // JSON payload to re-audit. Keep them intact when restarting AI.
  const extractionExclusions = {
    OR: [
      { ai_reason: { startsWith: "Pre-filter:" } },
      { ai_reason: { startsWith: "System Discard: Draft" } },
      { ai_reason: { startsWith: "Self-forward:" } },
    ],
  };
  const retainedDiscards = await prisma.email.count({
    where: {
      file_id: { in: targetPstIds },
      is_duplicate: 0,
      ai_decision: "discard",
      ...extractionExclusions,
    },
  });

  await prisma.$transaction([
    // Clear durable Batch claims before allowing a new AI run.  Any remote
    // batches from the previous run must be cancelled separately; this reset
    // intentionally never reuses their request ownership.
    prisma.email.updateMany({
      where: { file_id: { in: targetPstIds } },
      data: { ai_batch_run_id: null },
    }),
    prisma.aiBatchRun.deleteMany({
      where: { coordinator_id: coordinator },
    }),
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
    // Keep extraction-time exclusions; clear all decisions made by the AI pass.
    prisma.email.updateMany({
      where: {
        file_id: { in: targetPstIds },
        NOT: extractionExclusions,
      },
      data: { ai_decision: null, ai_reason: null },
    }),
    prisma.processedFile.update({
      where: { id: coordinator },
      data: { ai_discarded_count: retainedDiscards },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        caseKey: nonNullKey,
        pstRowsReset: targetPstIds.length,
        retainedExtractionExclusions: retainedDiscards,
        message:
          "AI/PDF state reset; Parse and Extract artifacts were preserved. Re-run from UI to continue at AI phase.",
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
