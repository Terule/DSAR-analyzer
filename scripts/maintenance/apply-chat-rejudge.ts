/**
 * Applies a re-judgement of the Teams chats of a finished request (reports made
 * by `rejudge-chats.ts`) without running the Files phase again:
 *
 *  - delivered chats the report discards go back to `Discarded/Messages/`
 *    under their original hash name;
 *  - delivered chats that stay, plus the discarded chats the second report now
 *    keeps, are numbered again from 1 in `Messages/`;
 *  - verdicts, audit-trail items (and the chat messages inside them), the CSVs
 *    and the SharePoint upload ledger follow, and the new set is queued.
 *
 *   node --import tsx scripts/maintenance/apply-chat-rejudge.ts --case JPF \
 *     --request R1 --kept-report a.tsv --discarded-report b.tsv [--apply]
 *
 * Without `--apply` it only checks and prints the plan. Anything the reports
 * could not decide (failed, review) is left where it is.
 *
 * Delivered chats are numbered `Message 0001.pdf`...: the original name of each
 * is recovered from the order the finalize step used (the hash names sorted
 * numerically), and refused unless the numbers are contiguous and as many as
 * the kept verdicts.
 */
import fs from "node:fs";
import path from "node:path";
import { refreshRequestLifecycle } from "../../src/lib/cases";
import { exportAuditTrail, recordFileItems } from "../../src/lib/items";
import { prisma } from "../../src/lib/prisma";
import {
  queueSharePointArtifacts,
  refreshSharePointUploadProgress,
} from "../../src/lib/sharepoint-artifact-outbox";
import { startSharePointArtifactWorker } from "../../src/lib/sharepoint-artifact-queue";
import { finalizeStandaloneDeliverables } from "../../src/lib/standalone-processor";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const caseName = arg("--case");
const requestName = arg("--request");
const keptReport = arg("--kept-report");
const discardedReport = arg("--discarded-report");
const apply = process.argv.includes("--apply");
const PREFIX = "Re-judged with the Teams chat rule: ";

const readReport = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true });

async function main() {
  if (!caseName || !requestName || !keptReport || !discardedReport) {
    throw new Error(
      "Usage: --case C --request R --kept-report a.tsv --discarded-report b.tsv [--apply]",
    );
  }
  const request = await prisma.caseRequest.findFirstOrThrow({
    where: { name: requestName, case: { name: caseName } },
    select: { id: true, deliverable_path: true },
  });
  const filesRow = await prisma.processedFile.findFirstOrThrow({
    where: { case_request_id: request.id, kind: "files" },
    select: { id: true },
  });
  const root = request.deliverable_path;
  const messagesDir = path.join(root, "Messages");
  const discardedDir = path.join(root, "Discarded", "Messages");

  // 1. Which hash name each delivered number was.
  const keptVerdicts = await prisma.filesAiVerdict.findMany({
    where: {
      file_id: filesRow.id,
      verdict: "keep",
      rel_path: { startsWith: "Messages/" },
    },
    select: { rel_path: true, reason: true },
  });
  const original = keptVerdicts
    .map((v) => ({
      hashName: path.basename(v.rel_path),
      relPath: v.rel_path,
      reason: v.reason ?? "",
    }))
    .sort((a, b) => byName(a.hashName, b.hashName));
  const delivered = fs
    .readdirSync(messagesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^Message \d+\.pdf$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(byName);
  const contiguous = delivered.every(
    (name, index) => Number(name.match(/\d+/)?.[0]) === index + 1,
  );
  if (delivered.length !== original.length || !contiguous) {
    throw new Error(
      `Cannot map delivered chats to their originals: ${delivered.length} files, ${original.length} kept verdicts, contiguous=${contiguous}.`,
    );
  }
  const originalOf = new Map(delivered.map((name, i) => [name, original[i]]));

  // The order is only an inference, so prove it: the title of each chat PDF is
  // the name of the file it came from, and the audit trail keeps the same name.
  const { fileItemId } = await import("../../src/lib/items");
  const { readPdfSample } = await import("../../src/lib/files-ai-extract");
  const { mapLimit } = await import("../../src/lib/second-review");
  const labels = new Map(
    (
      await prisma.item.findMany({
        where: { file_id: filesRow.id, kind: "file" },
        select: { id: true, label: true },
      })
    ).map((item) => [item.id, item.label ?? ""]),
  );
  const mismatches: string[] = [];
  await mapLimit(delivered, 8, async (name) => {
    const o = originalOf.get(name);
    const label = o
      ? (labels.get(fileItemId(filesRow.id, o.relPath)) ?? "")
      : "";
    const source = path.basename(label.replace(/\\/g, "/"));
    const text = (await readPdfSample(path.join(messagesDir, name), 1)).text;
    const norm = (value: string) =>
      value.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!source || !norm(text).includes(norm(source))) mismatches.push(name);
  });
  if (mismatches.length > 0) {
    throw new Error(
      `The delivered numbers do not match the originals for ${mismatches.length} chats (first: ${mismatches.slice(0, 3).join(", ")}). Nothing was changed.`,
    );
  }
  console.log(
    `Mapping verified: all ${delivered.length} chat titles match their originals.`,
  );

  // 2. The plan.
  const keptRows = readReport(keptReport);
  const reportOf = new Map(keptRows.map((row) => [row[0], row]));
  const toDiscard = delivered.filter((n) => reportOf.get(n)?.[1] === "discard");
  const stay = delivered.filter((n) => !toDiscard.includes(n));
  const restore = readReport(discardedReport)
    .filter((row) => row[1] === "keep")
    .map((row) => ({
      relPath: row[0],
      hashName: path.basename(row[0]),
      reason: row[4] ?? "",
      sensitivity: row[2] || null,
      relevance: row[3] || null,
    }));
  for (const r of restore) {
    if (!fs.existsSync(path.join(discardedDir, r.hashName))) {
      throw new Error(`Not found in Discarded/Messages: ${r.hashName}`);
    }
  }
  console.log(
    `Delivered chats: ${delivered.length}. Back to Discarded: ${toDiscard.length}. Stay: ${stay.length}. Restored from Discarded: ${restore.length}. Final Messages: ${stay.length + restore.length}.`,
  );
  console.log(
    "Mapping check (delivered number -> original reason | new reason):",
  );
  for (const name of stay.slice(0, 5)) {
    console.log(
      `  ${name}: ${originalOf.get(name)?.reason.slice(0, 90)} | ${(reportOf.get(name)?.[3] ?? "").slice(0, 90)}`,
    );
  }
  if (!apply) {
    console.log("Dry run: nothing was changed.");
    return;
  }

  // 3. Files: back to hash names, then numbered again.
  fs.mkdirSync(discardedDir, { recursive: true });
  for (const name of toDiscard) {
    const o = originalOf.get(name);
    if (!o) continue;
    fs.renameSync(
      path.join(messagesDir, name),
      path.join(discardedDir, o.hashName),
    );
  }
  for (const name of stay) {
    const o = originalOf.get(name);
    if (!o) continue;
    fs.renameSync(
      path.join(messagesDir, name),
      path.join(messagesDir, o.hashName),
    );
  }
  for (const r of restore) {
    fs.renameSync(
      path.join(discardedDir, r.hashName),
      path.join(messagesDir, r.hashName),
    );
  }
  finalizeStandaloneDeliverables({
    messagesDir,
    documentsDir: path.join(root, ".no-documents-here"),
  });
  const finalNames = fs
    .readdirSync(messagesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^Message \d+\.pdf$/.test(entry.name))
    .map((entry) => path.join(messagesDir, entry.name));
  console.log(`Messages now holds ${finalNames.length} numbered chats.`);

  // 4. Verdicts and the audit trail.
  const discardedItems = toDiscard.flatMap((name) => {
    const o = originalOf.get(name);
    return o
      ? [
          {
            relPath: o.relPath,
            reason: `${PREFIX}${reportOf.get(name)?.[3] ?? ""}`.slice(0, 240),
          },
        ]
      : [];
  });
  for (const item of discardedItems) {
    await prisma.filesAiVerdict.updateMany({
      where: { file_id: filesRow.id, rel_path: item.relPath },
      data: {
        verdict: "discard",
        reason: item.reason,
        reviewed_by_model: "haiku-5.5",
        resolved_at: new Date(),
      },
    });
  }
  for (const r of restore) {
    await prisma.filesAiVerdict.updateMany({
      where: { file_id: filesRow.id, rel_path: r.relPath },
      data: {
        verdict: "keep",
        reason: `${PREFIX}${r.reason}`.slice(0, 240),
        relevance: r.relevance,
        sensitivity: r.sensitivity,
        reviewed_by_model: "haiku-5.5",
        resolved_at: new Date(),
      },
    });
  }
  await recordFileItems(filesRow.id, [
    ...discardedItems.map((item) => ({
      relPath: item.relPath,
      state: "discarded" as const,
      rule: "ai_file",
      reason: item.reason,
      decidedBy: "haiku-5.5",
    })),
    ...restore.map((r) => ({
      relPath: r.relPath,
      state: "kept" as const,
      rule: "ai_file",
      reason: `${PREFIX}${r.reason}`.slice(0, 240),
      decidedBy: "haiku-5.5",
    })),
  ]);
  // The chat messages inside a discarded chat are discarded with it.
  const parentIds = discardedItems.map((item) =>
    fileItemId(filesRow.id, item.relPath),
  );
  let children = 0;
  for (let start = 0; start < parentIds.length; start += 200) {
    const chunk = parentIds.slice(start, start + 200);
    const rows = await prisma.item.findMany({
      where: { parent_id: { in: chunk }, state: "kept" },
      select: { id: true },
    });
    for (let i = 0; i < rows.length; i += 5_000) {
      const ids = rows.slice(i, i + 5_000).map((row) => row.id);
      await prisma.$transaction([
        prisma.itemEvent.createMany({
          data: ids.map((id) => ({
            item_id: id,
            state: "discarded",
            decision_rule: "ai_file",
            reason: "The chat was judged work talk.",
            decided_by: "haiku-5.5",
          })),
        }),
        prisma.item.updateMany({
          where: { id: { in: ids } },
          data: {
            state: "discarded",
            decision_rule: "ai_file",
            reason: "The chat was judged work talk.",
            decided_by: "haiku-5.5",
          },
        }),
      ]);
      children += ids.length;
    }
  }
  console.log(
    `${children} chat-message items marked discarded with their chat.`,
  );

  // 5. Counters, CSVs.
  const shift = toDiscard.length - restore.length;
  await prisma.processedFile.update({
    where: { id: filesRow.id },
    data: {
      files_processed: { decrement: shift },
      files_skipped: { increment: shift },
    },
  });
  const remaining = await prisma.filesAiVerdict.findMany({
    where: { verdict: "discard", file: { case_request_id: request.id } },
    select: { rel_path: true, reason: true },
    orderBy: [{ file_id: "asc" }, { rel_path: "asc" }],
  });
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  fs.writeFileSync(
    path.join(root, "Discarded", "verdicts.csv"),
    `${[
      "file,verdict,reason",
      ...remaining.map(
        (v) => `${cell(v.rel_path)},"discard",${cell(v.reason ?? "")}`,
      ),
    ].join("\n")}\n`,
  );
  await exportAuditTrail(request.id, root);

  // 6. SharePoint: the old Messages are gone there; forget them and queue the new set.
  const forgotten = await prisma.sharePointUploadArtifact.deleteMany({
    where: { local_path: { startsWith: `${messagesDir}${path.sep}` } },
  });
  const queued = await queueSharePointArtifacts(filesRow.id, finalNames);
  await refreshSharePointUploadProgress(filesRow.id);
  if (queued > 0) startSharePointArtifactWorker();
  await refreshRequestLifecycle(request.id);
  console.log(
    `Upload ledger: ${forgotten.count} old rows removed, ${queued} files queued.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
