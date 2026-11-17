/**
 * End-to-end check of the Files AI flow through the configured provider, on
 * SYNTHETIC files only. It creates a throwaway processed_files row, submits
 * copies of the given PDFs with prepareFilesAi, polls like the dispatcher,
 * compares verdicts with an expected manifest, then deletes everything it made.
 *
 *   node --import tsx scripts/maintenance/bedrock-files-ai-e2e.ts \
 *     <dirWithDocuments> <expected.json> <subject name> [--copies N] [--provider bedrock|openai]
 *
 * Run it INSIDE the app container (`docker compose cp` the script and the PDFs in,
 * then `docker compose exec app node --import tsx ...`): the Prisma client only
 * reaches the `postgres` host. For Batch the container needs BEDROCK_BATCH_BUCKET
 * and BEDROCK_BATCH_ROLE_ARN (set in .env).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  isFilesAiSettled,
  pollFilesAiBatches,
  prepareFilesAi,
} from "../../src/lib/files-ai";
import type { FilesAiCandidate } from "../../src/lib/files-ai-extract";
import { configuredFilesAiClient } from "../../src/lib/files-ai-provider";
import { prisma } from "../../src/lib/prisma";

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const copies = Number(opt("--copies") ?? 8);
  const provider = (opt("--provider") ?? "bedrock") as "bedrock" | "openai";
  const [dir, expectedPath, ...nameParts] = args;
  const subject = nameParts.join(" ");
  if (!dir || !expectedPath || !subject) throw new Error("missing arguments");
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as Record<
    string,
    { expect: string }
  >;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-e2e-"));
  const documentsDir = path.join(root, "Documents");
  const messagesDir = path.join(root, "Messages");
  const batchDir = path.join(root, "batches");
  for (const d of [documentsDir, messagesDir, batchDir]) fs.mkdirSync(d);

  const candidates: FilesAiCandidate[] = [];
  const want = new Map<string, string>();
  const source = path.join(dir, "Documents");
  for (let copy = 0; copy < copies; copy++) {
    for (const file of fs
      .readdirSync(source)
      .filter((f) => f.endsWith(".pdf"))) {
      const key = `Document/${file}`;
      if (!expected[key]) continue;
      const name = `Doc ${String(candidates.length + 1).padStart(4, "0")}.pdf`;
      fs.copyFileSync(path.join(source, file), path.join(documentsDir, name));
      candidates.push({
        relPath: `Documents/${name}`,
        kind: "Document",
        fileName: name,
        absPath: path.join(documentsDir, name),
      });
      want.set(`Documents/${name}`, expected[key].expect);
    }
  }
  console.log(
    `submitting ${candidates.length} synthetic files via ${provider}`,
  );

  const fileId = `t-e2e-${crypto.randomUUID().slice(0, 8)}`;
  await prisma.processedFile.create({
    data: { id: fileId, filename: "Files", kind: "files" },
  });
  try {
    const client = await configuredFilesAiClient({}, { provider });
    const started = Date.now();
    const prepared = await prepareFilesAi({
      fileId,
      dirs: { documentsDir, messagesDir },
      criteria: { name: subject, email: "", aliases: [] },
      client,
      mode: "client",
      candidates,
      batchDir,
    });
    console.log(
      `prepared: ${JSON.stringify(prepared)} in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    const runs = await prisma.filesAiBatchRun.findMany({
      where: { file_id: fileId },
      select: { openai_batch_id: true, request_count: true },
    });
    console.log(
      `runs: ${runs.map((r) => `${String(r.openai_batch_id).split(":")[0]} x${r.request_count}`).join(", ")}`,
    );

    const deadline = Date.now() + 40 * 60_000;
    while (!(await isFilesAiSettled(fileId)) && Date.now() < deadline) {
      await pollFilesAiBatches(fileId, client, batchDir);
      if (await isFilesAiSettled(fileId)) break;
      await new Promise((r) => setTimeout(r, 20_000));
    }
    console.log(`settled after ${Math.round((Date.now() - started) / 1000)}s`);

    const verdicts = await prisma.filesAiVerdict.findMany({
      where: { file_id: fileId },
      select: { rel_path: true, verdict: true },
    });
    const counts: Record<string, number> = {};
    let wrong = 0;
    let wrongKept = 0;
    for (const v of verdicts) {
      counts[v.verdict ?? "none"] = (counts[v.verdict ?? "none"] ?? 0) + 1;
      const expectKey = want.get(v.rel_path);
      if (expectKey && v.verdict !== expectKey && v.verdict !== "review") {
        wrong++;
        if (expectKey === "discard") wrongKept++;
      }
    }
    console.log(`verdicts: ${JSON.stringify(counts)}`);
    console.log(
      `mismatches (excluding review): ${wrong}, confidential kept: ${wrongKept}`,
    );

    const leftover = fs.readdirSync(batchDir);
    console.log(
      `batch dir leftovers: ${leftover.length} ${leftover.join(",")}`,
    );
    if (provider === "bedrock" && process.env.BEDROCK_BATCH_BUCKET) {
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
    await prisma.processedFile
      .delete({ where: { id: fileId } })
      .catch(() => undefined);
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
