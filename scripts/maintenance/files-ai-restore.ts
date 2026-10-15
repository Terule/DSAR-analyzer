/**
 * Re-judges the files the Files AI relevance check discarded, using the current
 * rules (subject-involved files are kept without the AI, long files are
 * sampled). Used to correct a request whose discards were made by an older,
 * weaker check.
 *
 *   node --import tsx scripts/maintenance/files-ai-restore.ts <case> <request>
 *       dry run: reads every discarded PDF and reports how many the keep guard
 *       would now restore. Changes nothing.
 *
 *   ... --apply
 *       moves every discarded file back, forgets their verdicts, corrects the
 *       counters and runs the Files AI prepare step again. Files the guard
 *       keeps are done; the rest go to OpenAI as a Batch run.
 *
 *   ... --finish
 *       once those batches have completed: queues the normal apply job (moves
 *       the new discards to `Discarded/`) and finalize job (numbers the
 *       restored files and queues them for upload), and waits for both.
 */
import fs from "node:fs";
import path from "node:path";
import { enqueueFilePhase } from "../../src/lib/control-plane/pipeline";
import { getControlPlanePool } from "../../src/lib/control-plane/postgres";
import { isFilesAiSettled } from "../../src/lib/files-ai";
import { writeVerdictsCsv } from "../../src/lib/files-ai-apply";
import { readPdfText } from "../../src/lib/files-ai-extract";
import { runFilesAiPrepare } from "../../src/lib/files-ai-gate";
import { subjectClearlyInvolved } from "../../src/lib/files-ai-text";
import { prisma } from "../../src/lib/prisma";

async function main() {
  const [caseName, requestName] = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");
  const finish = process.argv.includes("--finish");
  if (!caseName || !requestName) {
    throw new Error(
      "Usage: files-ai-restore <case> <request> [--apply|--finish]",
    );
  }
  const request = await prisma.caseRequest.findFirst({
    where: { name: requestName, case: { name: caseName } },
    include: { case: true },
  });
  if (!request) throw new Error(`No request ${caseName}/${requestName}`);
  const outDir = path.join(
    process.env.EXTRACTED_PATH || "",
    caseName,
    requestName,
  );
  const dirs = {
    messagesDir: path.join(outDir, "Messages"),
    documentsDir: path.join(outDir, "Documents"),
  };
  const criteria = {
    name: request.case.subject_name,
    email: request.case.subject_email,
    personalEmail: request.case.subject_personal_email || undefined,
    aliases: (request.case.subject_aliases ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };

  const discards = await prisma.filesAiVerdict.findMany({
    where: {
      verdict: "discard",
      file: { case_request_id: request.id, kind: "files" },
    },
    select: { file_id: true, rel_path: true },
    orderBy: { rel_path: "asc" },
  });
  const fileIds = [...new Set(discards.map((d) => d.file_id))];

  if (finish) {
    const rows = await prisma.processedFile.findMany({
      where: { case_request_id: request.id, kind: "files" },
      select: { id: true },
    });
    const stamp = Date.now();
    for (const { id: fileId } of rows) {
      if (!(await isFilesAiSettled(fileId))) {
        console.log(`${fileId}: AI batches still running; try again later.`);
        return;
      }
    }
    for (const step of ["Apply", "Finalize"] as const) {
      for (const { id: fileId } of rows) {
        const jobId = await enqueueFilePhase({
          fileId,
          phase: "files",
          dedupeKey: `files-ai-restore-${step.toLowerCase()}:${fileId}:${stamp}`,
          metadata:
            step === "Apply"
              ? { filesAiApply: true, runKey: `restore-${stamp}` }
              : { filesFinalize: true, runKey: `restore-${stamp}` },
        });
        console.log(`${step} job queued for ${fileId}: ${jobId}`);
        for (;;) {
          const state = await getControlPlanePool().query<{ status: string }>(
            "SELECT status FROM orchestrator_jobs WHERE id = $1",
            [jobId],
          );
          const status = state.rows[0]?.status;
          if (status === "completed") break;
          if (status === "dead_letter" || status === "failed") {
            throw new Error(`${step} job ${jobId} ended as ${status}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
      if (step === "Apply") {
        // The CSV lists only what is still discarded, even if that is nothing.
        const remaining = await prisma.filesAiVerdict.findMany({
          where: {
            verdict: "discard",
            file: { case_request_id: request.id, kind: "files" },
          },
          select: { rel_path: true, reason: true },
          orderBy: { rel_path: "asc" },
        });
        writeVerdictsCsv({
          requestOutputDir: outDir,
          rows: remaining.map((v) => ({
            relPath: v.rel_path,
            verdict: "discard",
            reason: v.reason ?? "",
          })),
        });
      }
    }
    console.log("Done: restored files are numbered and queued for upload.");
    return;
  }

  console.log(
    `${discards.length} discarded file(s) in ${caseName}/${requestName}`,
  );
  let involved = 0;
  const missing: string[] = [];
  for (const discard of discards) {
    const file = path.join(outDir, "Discarded", discard.rel_path);
    if (!fs.existsSync(file)) {
      missing.push(discard.rel_path);
      continue;
    }
    if (subjectClearlyInvolved(await readPdfText(file), criteria)) involved++;
  }
  console.log(
    `keep guard would restore ${involved}; ${discards.length - involved - missing.length} would go back to the AI; ${missing.length} missing from Discarded/`,
  );
  if (!apply) {
    console.log("Dry run. Re-run with --apply to restore and re-judge.");
    return;
  }

  for (const fileId of fileIds) {
    const mine = discards.filter((d) => d.file_id === fileId);
    let restored = 0;
    for (const discard of mine) {
      const from = path.join(outDir, "Discarded", discard.rel_path);
      const to = path.join(outDir, discard.rel_path);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      restored++;
    }
    await prisma.filesAiVerdict.deleteMany({
      where: { file_id: fileId, rel_path: { in: mine.map((d) => d.rel_path) } },
    });
    // The original apply recorded these files as skipped. Remove that result
    // (its job moved only files that are no longer discarded) and recompute
    // the row's counters from what remains.
    const pool = getControlPlanePool();
    await pool.query(
      `DELETE FROM orchestrator_files_batch_results
       WHERE file_id = $1 AND job_id IN (
         SELECT id FROM orchestrator_jobs
         WHERE payload->'metadata'->>'filesAiApply' = 'true')`,
      [fileId],
    );
    const sums = await pool.query<{ p: string; s: string; d: string }>(
      `SELECT COALESCE(SUM(processed_count),0)::text AS p,
              COALESCE(SUM(skipped_count),0)::text AS s,
              COALESCE(SUM(duplicates_count),0)::text AS d
       FROM orchestrator_files_batch_results WHERE file_id = $1`,
      [fileId],
    );
    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        files_processed: Number(sums.rows[0]?.p ?? 0),
        files_skipped: Number(sums.rows[0]?.s ?? 0),
        files_duplicates: Number(sums.rows[0]?.d ?? 0),
      },
    });
    console.log(`${fileId}: moved ${restored} file(s) back`);
    const result = await runFilesAiPrepare({ fileId, dirs, criteria });
    console.log(`${fileId}: prepare`, result);
  }
  console.log(
    "Batches submitted. When they complete, run again with --finish.",
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    // The control-plane pool would otherwise keep the process alive.
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
