/**
 * Judges again, with the image judge (Haiku 5.5 vision), the images of a
 * finished request that the Files AI gate discarded. Before the page-marker fix
 * (`stripPageMarkers`) the gate read a picture-only PDF as a document with
 * content, saw an empty page and discarded the image as "empty". The originals
 * are gone from staging, but the picture is still inside each discarded PDF.
 *
 *   node --import tsx scripts/maintenance/rejudge-images.ts --case JPF --request R1
 *   node --import tsx scripts/maintenance/rejudge-images.ts --case JPF --request R1 --apply
 *
 * Without `--apply` it is read-only and writes a report. With `--apply`:
 *   keep    -> back to `Documents/`, numbered after the existing ones, uploaded;
 *   review  -> `For Human Review/Documents/`, listed in `review.csv`, uploaded;
 *   discard -> stays in `Discarded/`.
 * The verdicts, audit-trail items, CSVs, counters and the upload ledger follow.
 */
import fs from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { refreshRequestLifecycle } from "../../src/lib/cases";
import { filesAiModeFor } from "../../src/lib/files-ai";
import {
  HUMAN_REVIEW_DIR,
  listHumanReviewDeliverables,
  writeReviewCsv,
} from "../../src/lib/files-ai-apply";
import { imageContentJudge } from "../../src/lib/image-vision";
import {
  exportAuditTrail,
  fileItemId,
  recordFileItems,
} from "../../src/lib/items";
import { prisma } from "../../src/lib/prisma";
import { mapLimit } from "../../src/lib/second-review";
import {
  queueSharePointArtifacts,
  refreshSharePointUploadProgress,
} from "../../src/lib/sharepoint-artifact-outbox";
import { startSharePointArtifactWorker } from "../../src/lib/sharepoint-artifact-queue";
import {
  finalizeStandaloneDeliverables,
  listFinalizedStandaloneDeliverables,
} from "../../src/lib/standalone-processor";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const caseName = arg("--case");
const requestName = arg("--request");
const apply = process.argv.includes("--apply");
const PREFIX = "Re-judged as an image: ";

async function firstImage(file: string): Promise<Buffer | null> {
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  try {
    const result = await parser.getImage({ imageThreshold: 0 });
    const image = result.pages?.[0]?.images?.[0];
    return image?.data ? Buffer.from(image.data) : null;
  } catch {
    return null;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

interface Outcome {
  relPath: string;
  label: string;
  verdict: "keep" | "discard" | "review" | "failed";
  reason: string;
}

async function main() {
  if (!caseName || !requestName) {
    throw new Error("Usage: --case C --request R [--apply]");
  }
  const request = await prisma.caseRequest.findFirstOrThrow({
    where: { name: requestName, case: { name: caseName } },
    select: { id: true, deliverable_path: true },
  });
  const filesRow = await prisma.processedFile.findFirstOrThrow({
    where: { case_request_id: request.id, kind: "files" },
    select: {
      id: true,
      subject_name: true,
      subject_email: true,
      subject_personal_email: true,
      subject_aliases: true,
    },
  });
  const root = request.deliverable_path;
  const judge = imageContentJudge(
    {
      name: filesRow.subject_name || "",
      email: filesRow.subject_email || "",
      personalEmail: filesRow.subject_personal_email || undefined,
      aliases: (filesRow.subject_aliases || "")
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean),
    },
    await filesAiModeFor(filesRow.id),
  );

  // The AI-discarded image files, with the delivered name of each.
  const verdicts = await prisma.filesAiVerdict.findMany({
    where: {
      file_id: filesRow.id,
      verdict: "discard",
      rel_path: { startsWith: "Documents/" },
    },
    select: { rel_path: true },
    orderBy: { rel_path: "asc" },
  });
  const labels = new Map(
    (
      await prisma.item.findMany({
        where: { file_id: filesRow.id, kind: "file", state: "discarded" },
        select: { id: true, label: true },
      })
    ).map((item) => [item.id, item.label ?? ""]),
  );
  const candidates = verdicts
    .map((v) => ({
      relPath: v.rel_path,
      label: labels.get(fileItemId(filesRow.id, v.rel_path)) ?? "",
    }))
    .filter((c) => /\.(png|jpe?g|gif|webp)$/i.test(c.label));
  console.log(
    `${candidates.length} discarded images to judge (${apply ? "APPLY" : "dry run"}).`,
  );

  const outcomes: Outcome[] = [];
  let done = 0;
  await mapLimit(candidates, 4, async (candidate) => {
    const file = path.join(root, "Discarded", candidate.relPath);
    const image = fs.existsSync(file) ? await firstImage(file) : null;
    if (!image) {
      outcomes.push({
        ...candidate,
        verdict: "failed",
        reason: "No picture found in the PDF.",
      });
    } else {
      const judged = await judge(image);
      outcomes.push({ ...candidate, ...judged });
    }
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${candidates.length} judged`);
  });

  const count = (verdict: Outcome["verdict"]) =>
    outcomes.filter((o) => o.verdict === verdict).length;
  const reportPath = `/tmp/rejudge-images-${caseName}-${requestName}.tsv`;
  fs.writeFileSync(
    reportPath,
    outcomes
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((o) =>
        [o.relPath, o.verdict, o.reason.replace(/\s+/g, " ")].join("\t"),
      )
      .join("\n"),
  );
  console.log(
    `Result: keep ${count("keep")}, review ${count("review")}, discard ${count("discard")}, no picture ${count("failed")}. Report: ${reportPath}`,
  );
  if (!apply) return;

  const keep = outcomes.filter((o) => o.verdict === "keep");
  const review = outcomes.filter((o) => o.verdict === "review");
  const documentsDir = path.join(root, "Documents");
  const reviewDir = path.join(root, HUMAN_REVIEW_DIR, "Documents");
  const before = new Set(
    listFinalizedStandaloneDeliverables({
      messagesDir: path.join(root, ".no-messages-here"),
      documentsDir,
    }),
  );
  fs.mkdirSync(documentsDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });
  for (const o of keep) {
    fs.renameSync(
      path.join(root, "Discarded", o.relPath),
      path.join(root, o.relPath),
    );
  }
  for (const o of review) {
    fs.renameSync(
      path.join(root, "Discarded", o.relPath),
      path.join(root, HUMAN_REVIEW_DIR, o.relPath),
    );
  }
  finalizeStandaloneDeliverables({
    messagesDir: path.join(root, ".no-messages-here"),
    documentsDir,
  });
  const added = listFinalizedStandaloneDeliverables({
    messagesDir: path.join(root, ".no-messages-here"),
    documentsDir,
  }).filter((file) => !before.has(file));

  const reasonOf = (o: Outcome) => `${PREFIX}${o.reason}`.slice(0, 240);
  for (const [list, verdict] of [
    [keep, "keep"],
    [review, "review"],
  ] as const) {
    for (const o of list) {
      await prisma.filesAiVerdict.updateMany({
        where: { file_id: filesRow.id, rel_path: o.relPath },
        data: {
          verdict,
          reason: reasonOf(o),
          reviewed_by_model: "haiku-5.5",
          resolved_at: new Date(),
        },
      });
    }
  }
  await recordFileItems(filesRow.id, [
    ...keep.map((o) => ({
      relPath: o.relPath,
      state: "kept" as const,
      rule: "ai_file",
      reason: reasonOf(o),
      decidedBy: "haiku-5.5",
    })),
    ...review.map((o) => ({
      relPath: o.relPath,
      state: "review" as const,
      rule: "ai_file",
      reason: reasonOf(o),
      decidedBy: "haiku-5.5",
    })),
  ]);
  const moved = keep.length + review.length;
  await prisma.processedFile.update({
    where: { id: filesRow.id },
    data: {
      files_processed: { increment: moved },
      files_skipped: { decrement: moved },
    },
  });
  const requestScope = { case_request_id: request.id, kind: "files" };
  const discards = await prisma.filesAiVerdict.findMany({
    where: { verdict: "discard", file: requestScope },
    select: { rel_path: true, reason: true },
    orderBy: [{ file_id: "asc" }, { rel_path: "asc" }],
  });
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  fs.writeFileSync(
    path.join(root, "Discarded", "verdicts.csv"),
    `${[
      "file,verdict,reason",
      ...discards.map(
        (v) => `${cell(v.rel_path)},"discard",${cell(v.reason ?? "")}`,
      ),
    ].join("\n")}\n`,
  );
  const reviews = await prisma.filesAiVerdict.findMany({
    where: { verdict: "review", file: requestScope },
    select: { rel_path: true, reason: true },
    orderBy: [{ file_id: "asc" }, { rel_path: "asc" }],
  });
  writeReviewCsv({
    requestOutputDir: root,
    rows: reviews.map((v) => ({
      relPath: v.rel_path,
      reason: v.reason ?? "",
    })),
  });
  await exportAuditTrail(request.id, root);
  const queued = await queueSharePointArtifacts(filesRow.id, [
    ...added,
    ...listHumanReviewDeliverables(root),
  ]);
  await refreshSharePointUploadProgress(filesRow.id);
  if (queued > 0) startSharePointArtifactWorker();
  await refreshRequestLifecycle(request.id);
  console.log(
    `Kept ${keep.length} (numbered as ${added.length} new documents), ${review.length} to human review, ${queued} files queued for SharePoint.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
