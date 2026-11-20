/**
 * End-to-end check of the employee email audit on Bedrock, on SYNTHETIC emails
 * only. It creates a throwaway case with one PST row, writes the payloads of the
 * given cases files (repeated --copies times so the run is large enough for
 * Batch), submits with generateBatchFile, polls and runs the second review like
 * the dispatcher, compares final decisions with each case's `expect`, then
 * deletes everything it made.
 *
 *   node --import tsx scripts/maintenance/bedrock-email-e2e.ts \
 *     <cases.json>[,<more.json>] <subject name> <subject email> [--copies N]
 *
 * Run it INSIDE the app container (the Prisma client only reaches `postgres`);
 * it needs BEDROCK_BATCH_BUCKET and BEDROCK_BATCH_ROLE_ARN (set in .env).
 * More than 100 emails go to Batch (Haiku 4.5) and their doubtful discards to
 * the second review (Haiku 5.5).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { emailAiTestOverride, generateBatchFile } from "../../src/lib/ai";
import { pollBatchStatus } from "../../src/lib/batch-worker";
import { rereviewEmailDiscards } from "../../src/lib/email-rereview";
import { configuredFilesAiClient } from "../../src/lib/files-ai-provider";
import { prisma } from "../../src/lib/prisma";
import { getPstWorkFolder } from "../../src/lib/pst-artifacts";

interface Case {
  id: string;
  expect: "keep" | "discard";
  why: string;
  payload: unknown;
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--copies");
  const copies = i >= 0 ? Number(args.splice(i, 2)[1]) : 6;
  const [files, name, email] = args;
  if (!files || !name || !email) throw new Error("missing arguments");
  const cases = files
    .split(",")
    .flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")) as Case[]);

  const tag = crypto.randomUUID().slice(0, 8);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "email-e2e-"));
  const staging = path.join(root, "staging");
  const extracted = path.join(root, "extracted");
  process.env.STAGING_PATH = staging;
  process.env.EXTRACTED_PATH = extracted;

  const caseId = `t-ee-case-${tag}`;
  const requestId = `t-ee-req-${tag}`;
  const fileId = `t-ee-file-${tag}`;
  const filepath = path.join(staging, `ZZ-${caseId}`, "R1", "PST", "a.pst");
  const unique = path.join(
    getPstWorkFolder({
      fileId,
      filepath,
      stagingPath: staging,
      extractedPath: extracted,
    }),
    ".unique-emails",
  );
  const dirs = {
    json: path.join(unique, "json-files"),
    raw: path.join(unique, "raw-emails"),
    selected: path.join(unique, "selected"),
    discarded: path.join(unique, "discarded"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  try {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-${caseId}`,
        subject_name: name,
        subject_email: email,
        case_type: "employee",
      },
    });
    await prisma.caseRequest.create({
      data: {
        id: requestId,
        case_id: caseId,
        name: "R1",
        scope: "mail",
        status: "running",
        staging_path: path.join(staging, `ZZ-${caseId}`, "R1"),
        deliverable_path: path.join(extracted, `ZZ-${caseId}`, "R1"),
      },
    });
    await prisma.processedFile.create({
      data: {
        id: fileId,
        filename: "a.pst",
        kind: "pst",
        filepath,
        case_request_id: requestId,
        subject_name: name,
        subject_email: email,
        ai_status: "processing",
        ai_started_at: BigInt(Date.now()),
      },
    });

    const want = new Map<string, Case>();
    for (let copy = 0; copy < copies; copy++) {
      for (const c of cases) {
        const hash = `${tag}-${c.id}-${copy}`;
        fs.writeFileSync(
          path.join(dirs.json, `${hash}.json`),
          JSON.stringify(c.payload),
        );
        fs.writeFileSync(path.join(dirs.raw, `${hash}.eml`), "eml");
        await prisma.email.create({
          data: {
            id: crypto.randomUUID(),
            file_id: fileId,
            email_hash: hash,
            is_duplicate: 0,
          },
        });
        want.set(hash, c);
      }
    }
    console.log(`submitting ${want.size} synthetic emails`);

    emailAiTestOverride.client = await configuredFilesAiClient();
    const started = Date.now();
    console.log(
      `generateBatchFile: ${await generateBatchFile(fileId, {
        name,
        email,
        aliases: [],
      })}`,
    );
    const runs = await prisma.aiBatchRun.findMany({
      where: { coordinator_id: fileId, kind: "email" },
      select: { openai_batch_id: true, request_count: true },
    });
    console.log(
      `runs: ${runs.map((r) => String(r.openai_batch_id).split(":")[0]).join(", ")}`,
    );

    const deadline = Date.now() + 40 * 60_000;
    let queued = 0;
    for (;;) {
      await pollBatchStatus(fileId);
      queued = Math.max(
        queued,
        await prisma.item.count({
          where: {
            file_id: fileId,
            kind: "email",
            rereview_status: { not: null },
          },
        }),
      );
      await rereviewEmailDiscards({ coordinatorId: fileId });
      const open = await prisma.item.count({
        where: {
          file_id: fileId,
          kind: "email",
          OR: [{ state: "pending" }, { rereview_status: { not: null } }],
        },
      });
      const active = await prisma.aiBatchRun.count({
        where: {
          coordinator_id: fileId,
          kind: "email",
          status: { in: ["claiming", "submitted", "processing"] },
        },
      });
      const status = (
        await prisma.processedFile.findUniqueOrThrow({
          where: { id: fileId },
          select: { ai_status: true },
        })
      ).ai_status;
      if (open === 0 && active === 0 && status !== "processing") break;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20_000));
    }
    console.log(`settled after ${Math.round((Date.now() - started) / 1000)}s`);

    const rows = await prisma.email.findMany({
      where: { file_id: fileId },
      select: { email_hash: true, ai_decision: true, ai_reason: true },
    });
    const reviewed = rows.filter((r) =>
      /second review/i.test(r.ai_reason ?? ""),
    );
    const byReview: Record<string, number> = {};
    for (const r of reviewed) {
      const key = `${r.ai_decision}`;
      byReview[key] = (byReview[key] ?? 0) + 1;
    }
    console.log(
      `second review: ${queued} queued, ${reviewed.length} settled, outcomes ${JSON.stringify(byReview)}`,
    );
    const counts: Record<string, number> = {};
    const wrongDiscards = new Set<string>();
    const wrongKeeps = new Set<string>();
    for (const r of rows) {
      counts[r.ai_decision ?? "none"] =
        (counts[r.ai_decision ?? "none"] ?? 0) + 1;
      const c = want.get(r.email_hash);
      if (!c || r.ai_decision === c.expect) continue;
      (c.expect === "keep" ? wrongDiscards : wrongKeeps).add(
        `${c.id} (${c.why})`,
      );
    }
    console.log(`decisions: ${JSON.stringify(counts)}`);
    console.log(
      `wrong discards (expected keep): ${[...wrongDiscards].join("; ") || "none"}`,
    );
    console.log(
      `kept but expected discard: ${[...wrongKeeps].join("; ") || "none"}`,
    );
    // The folders must agree with the decisions.
    const sel = new Set(
      fs.readdirSync(dirs.selected).map((f) => f.replace(".eml", "")),
    );
    const mismatchedFolders = rows.filter(
      (r) => (r.ai_decision === "keep") !== sel.has(r.email_hash),
    ).length;
    console.log(
      `selected/ files: ${sel.size}, rows whose folder disagrees: ${mismatchedFolders}`,
    );
    const leftover = fs
      .readdirSync(path.join(process.cwd(), "batches"))
      .filter((f) => f.includes(fileId));
    console.log(`batch dir leftovers for this case: ${leftover.length}`);
    if (process.env.BEDROCK_BATCH_BUCKET) {
      const s3 = new S3Client({
        region: process.env.AWS_REGION || "eu-central-1",
      });
      for (const prefix of ["input/", "output/"]) {
        const listed = await s3.send(
          new ListObjectsV2Command({
            Bucket: process.env.BEDROCK_BATCH_BUCKET,
            Prefix: prefix,
          }),
        );
        console.log(`S3 ${prefix} objects: ${listed.KeyCount ?? 0}`);
      }
    }
  } finally {
    emailAiTestOverride.client = undefined;
    await prisma.email.deleteMany({
      where: { email_hash: { startsWith: `${tag}-` } },
    });
    await prisma.aiBatchRun.deleteMany({ where: { coordinator_id: fileId } });
    await prisma.filesAiVerdict
      .deleteMany({ where: { file_id: fileId } })
      .catch(() => undefined);
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
