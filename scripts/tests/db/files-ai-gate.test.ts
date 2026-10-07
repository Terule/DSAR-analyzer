import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { recordFilesBatchResult } from "../../../src/lib/control-plane/job-store";
import {
  closeControlPlanePool,
  getControlPlanePool,
} from "../../../src/lib/control-plane/postgres";
import { ensureControlPlaneSchema } from "../../../src/lib/control-plane/schema";
import type { FilesAiClient } from "../../../src/lib/files-ai";
import {
  advanceFilesAi,
  applyFilesAiVerdicts,
  filesAiRequired,
  runFilesAiPrepare,
} from "../../../src/lib/files-ai-gate";
import {
  getAiBatchSettings,
  updateAiBatchSettings,
} from "../../../src/lib/pipeline-settings";
import { prisma } from "../../../src/lib/prisma";
import { closeQueueAdapter } from "../../../src/lib/queue/factory";

const tag = crypto.randomUUID().slice(0, 8);
const employeeCase = `t-fag-emp-${tag}`;
const clientCase = `t-fag-cli-${tag}`;
const fileIds: string[] = [];
const jobIds: string[] = [];
let counter = 0;
let originalEnabled = true;

async function makeCase(id: string, type: "employee" | "client") {
  await prisma.managedCase.create({
    data: {
      id,
      name: `ZZ-${id}`,
      subject_name: "Jonathan Wheeler",
      subject_email: "jw@corp.com",
      case_type: type,
    },
  });
}

async function makeFilesRow(caseId: string | null) {
  counter++;
  const id = `t-fag-file-${tag}-${counter}`;
  let requestId: string | null = null;
  if (caseId) {
    requestId = `t-fag-req-${tag}-${counter}`;
    await prisma.caseRequest.create({
      data: {
        id: requestId,
        case_id: caseId,
        name: `R${counter}`,
        scope: "files",
        status: "running",
        staging_path: `/tmp/${requestId}/s`,
        deliverable_path: `/tmp/${requestId}/d`,
      },
    });
  }
  await prisma.processedFile.create({
    data: {
      id,
      filename: "Files",
      kind: "files",
      filepath: `/data/Staging/ZZ/${id}/Files`,
      case_request_id: requestId,
    },
  });
  fileIds.push(id);
  return id;
}

async function makeJob(fileId: string): Promise<string> {
  const id = crypto.randomUUID();
  jobIds.push(id);
  await getControlPlanePool().query(
    `INSERT INTO orchestrator_jobs (id, phase, status, dedupe_key, payload, attempts, max_attempts)
     VALUES ($1, 'files', 'running', $2, $3::jsonb, 1, 5)`,
    [
      id,
      `t-fag-${id}`,
      JSON.stringify({ fileId, phase: "files", caseKey: "t" }),
    ],
  );
  return id;
}

async function stageJobs(fileId: string, runKey: string) {
  const result = await getControlPlanePool().query(
    `SELECT id, status, payload->'metadata' AS metadata
       FROM orchestrator_jobs
      WHERE payload->>'fileId' = $1 AND payload->'metadata'->>'runKey' = $2
      ORDER BY created_at`,
    [fileId, runKey],
  );
  for (const row of result.rows) jobIds.push(row.id);
  return result.rows as Array<{
    id: string;
    status: string;
    metadata: Record<string, unknown>;
  }>;
}

async function setStage(
  fileId: string,
  runKey: string,
  stage: string,
  status: string,
) {
  await getControlPlanePool().query(
    `UPDATE orchestrator_jobs SET status = $3
      WHERE payload->>'fileId' = $1
        AND payload->'metadata'->>'runKey' = $2
        AND payload->'metadata'->>'${stage}' = 'true'`,
    [fileId, runKey, status],
  );
}

describe("Files AI gate", () => {
  before(async () => {
    await ensureControlPlaneSchema();
    originalEnabled = (await getAiBatchSettings()).filesAiEnabled ?? true;
    await makeCase(employeeCase, "employee");
    await makeCase(clientCase, "client");
  });
  after(async () => {
    await getControlPlanePool().query(
      "DELETE FROM orchestrator_jobs WHERE id = ANY($1::uuid[])",
      [jobIds],
    );
    await getControlPlanePool().query(
      "DELETE FROM orchestrator_files_batch_results WHERE file_id = ANY($1)",
      [fileIds],
    );
    await prisma.processedFile.deleteMany({ where: { id: { in: fileIds } } });
    await prisma.caseRequest.deleteMany({
      where: { case_id: { in: [employeeCase, clientCase] } },
    });
    await prisma.managedCase.deleteMany({
      where: { id: { in: [employeeCase, clientCase] } },
    });
    await prisma.pipelineSettings.updateMany({
      data: { files_ai_enabled: originalEnabled },
    });
    await prisma.$disconnect();
    await closeQueueAdapter();
    await closeControlPlanePool();
  });

  describe("filesAiRequired", () => {
    it("is true for an employee case with the setting on", async () => {
      await prisma.pipelineSettings.updateMany({
        data: { files_ai_enabled: true },
      });
      assert.equal(
        await filesAiRequired(await makeFilesRow(employeeCase)),
        true,
      );
    });
    it("is false when the setting is off", async () => {
      const current = await getAiBatchSettings();
      await updateAiBatchSettings({ ...current, filesAiEnabled: false });
      assert.equal(
        await filesAiRequired(await makeFilesRow(employeeCase)),
        false,
      );
      await updateAiBatchSettings({ ...current, filesAiEnabled: true });
    });
    it("is false for a client case", async () => {
      assert.equal(
        await filesAiRequired(await makeFilesRow(clientCase)),
        false,
      );
    });
    it("is false for a row with no request", async () => {
      assert.equal(await filesAiRequired(await makeFilesRow(null)), false);
    });
  });

  describe("advanceFilesAi", () => {
    it("enqueues prepare once and waits", async () => {
      const fileId = await makeFilesRow(employeeCase);
      assert.equal(await advanceFilesAi(fileId, "run-1"), "waiting");
      assert.equal(await advanceFilesAi(fileId, "run-1"), "waiting");
      const jobs = await stageJobs(fileId, "run-1");
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].metadata.filesAiPrepare, true);
    });

    it("waits while a batch is in flight, then enqueues apply, then is ready", async () => {
      const fileId = await makeFilesRow(employeeCase);
      await advanceFilesAi(fileId, "run-1");
      await setStage(fileId, "run-1", "filesAiPrepare", "completed");
      await prisma.filesAiBatchRun.create({
        data: { id: `run-${fileId}`, file_id: fileId, status: "submitted" },
      });
      assert.equal(await advanceFilesAi(fileId, "run-1"), "waiting");
      assert.equal((await stageJobs(fileId, "run-1")).length, 1); // no apply yet

      await prisma.filesAiBatchRun.update({
        where: { id: `run-${fileId}` },
        data: { status: "completed" },
      });
      assert.equal(await advanceFilesAi(fileId, "run-1"), "waiting");
      assert.equal(await advanceFilesAi(fileId, "run-1"), "waiting");
      const jobs = await stageJobs(fileId, "run-1");
      assert.equal(
        jobs.filter((j) => j.metadata.filesAiApply === true).length,
        1,
      );

      await setStage(fileId, "run-1", "filesAiApply", "completed");
      assert.equal(await advanceFilesAi(fileId, "run-1"), "ready");
    });

    it("delivers everything when prepare dead-letters", async () => {
      const fileId = await makeFilesRow(employeeCase);
      await advanceFilesAi(fileId, "run-1");
      await setStage(fileId, "run-1", "filesAiPrepare", "dead_letter");
      assert.equal(await advanceFilesAi(fileId, "run-1"), "ready");
    });

    it("does not deliver past an in-flight batch when prepare dead-letters after submitting", async () => {
      const fileId = await makeFilesRow(employeeCase);
      await advanceFilesAi(fileId, "run-1");
      await setStage(fileId, "run-1", "filesAiPrepare", "dead_letter");
      const runId = `run-dl-${fileId}`;
      await prisma.filesAiBatchRun.create({
        data: { id: runId, file_id: fileId, status: "submitted" },
      });
      await prisma.filesAiVerdict.createMany({
        data: [
          {
            id: `${fileId}:Documents/Document 5555555555555555.pdf`,
            file_id: fileId,
            rel_path: "Documents/Document 5555555555555555.pdf",
            batch_run_id: runId,
          },
          {
            id: `${fileId}:Documents/Document 6666666666666666.pdf`,
            file_id: fileId,
            rel_path: "Documents/Document 6666666666666666.pdf",
          },
        ],
      });
      // The batch is still out: wait for it instead of delivering.
      assert.equal(await advanceFilesAi(fileId, "run-1"), "waiting");
      // The chunk that never got submitted is kept, not left pending forever.
      const unsent = await prisma.filesAiVerdict.findUniqueOrThrow({
        where: { id: `${fileId}:Documents/Document 6666666666666666.pdf` },
      });
      assert.equal(unsent.verdict, "keep");

      // Once the batch is read, its discard is applied before finalize.
      await prisma.filesAiVerdict.update({
        where: { id: `${fileId}:Documents/Document 5555555555555555.pdf` },
        data: { verdict: "discard", reason: "r" },
      });
      await prisma.filesAiBatchRun.update({
        where: { id: runId },
        data: { status: "completed" },
      });
      assert.equal(await advanceFilesAi(fileId, "run-1"), "waiting");
      const jobs = await stageJobs(fileId, "run-1");
      assert.equal(
        jobs.filter((j) => j.metadata.filesAiApply === true).length,
        1,
      );
    });

    it("fails loudly when apply dead-letters", async () => {
      const fileId = await makeFilesRow(employeeCase);
      await advanceFilesAi(fileId, "run-1");
      await setStage(fileId, "run-1", "filesAiPrepare", "completed");
      await advanceFilesAi(fileId, "run-1"); // enqueues apply
      await setStage(fileId, "run-1", "filesAiApply", "dead_letter");
      assert.equal(await advanceFilesAi(fileId, "run-1"), "failed");
    });
  });

  describe("applyFilesAiVerdicts", () => {
    it("moves discards, writes the CSV and counts them as skipped exactly once", async () => {
      const fileId = await makeFilesRow(employeeCase);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "fag-"));
      fs.mkdirSync(path.join(root, "Documents"));
      fs.writeFileSync(
        path.join(root, "Documents", "Document aaaaaaaaaaaaaaaa.pdf"),
        "a",
      );
      fs.writeFileSync(
        path.join(root, "Documents", "Document bbbbbbbbbbbbbbbb.pdf"),
        "b",
      );
      fs.writeFileSync(
        path.join(root, "Documents", "Document cccccccccccccccc.pdf"),
        "c",
      );
      for (const [name, verdict] of [
        ["aaaaaaaaaaaaaaaa", "discard"],
        ["bbbbbbbbbbbbbbbb", "discard"],
        ["cccccccccccccccc", "keep"],
      ] as const) {
        await prisma.filesAiVerdict.create({
          data: {
            id: `${fileId}:Documents/Document ${name}.pdf`,
            file_id: fileId,
            rel_path: `Documents/Document ${name}.pdf`,
            verdict,
            reason: `reason ${name}`,
          },
        });
      }
      await recordFilesBatchResult({
        jobId: await makeJob(fileId),
        fileId,
        processed: 10,
        skipped: 5,
        duplicates: 2,
      });

      const jobId = await makeJob(fileId);
      const first = await applyFilesAiVerdicts({
        jobId,
        fileId,
        requestOutputDir: root,
      });
      assert.equal(first.discarded, 2);
      const row = await prisma.processedFile.findUniqueOrThrow({
        where: { id: fileId },
      });
      assert.equal(row.files_processed, 8);
      assert.equal(row.files_skipped, 7);
      assert.equal(row.files_duplicates, 2);
      assert.equal(
        fs.existsSync(
          path.join(
            root,
            "Discarded",
            "Documents",
            "Document aaaaaaaaaaaaaaaa.pdf",
          ),
        ),
        true,
      );
      assert.equal(
        fs.existsSync(
          path.join(root, "Documents", "Document cccccccccccccccc.pdf"),
        ),
        true,
      );
      const csv = fs.readFileSync(
        path.join(root, "Discarded", "verdicts.csv"),
        "utf8",
      );
      assert.match(csv, /reason aaaaaaaaaaaaaaaa/);
      assert.doesNotMatch(csv, /cccccccccccccccc/);

      await applyFilesAiVerdicts({ jobId, fileId, requestOutputDir: root }); // re-run
      const again = await prisma.processedFile.findUniqueOrThrow({
        where: { id: fileId },
      });
      assert.equal(again.files_processed, 8);
      assert.equal(again.files_skipped, 7);
    });

    it("changes nothing when there are no discards", async () => {
      const fileId = await makeFilesRow(employeeCase);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "fag-"));
      const result = await applyFilesAiVerdicts({
        jobId: await makeJob(fileId),
        fileId,
        requestOutputDir: root,
      });
      assert.equal(result.discarded, 0);
      assert.equal(fs.existsSync(path.join(root, "Discarded")), false);
    });
  });

  describe("runFilesAiPrepare", () => {
    const criteria = {
      name: "Jonathan Wheeler",
      email: "jw@corp.com",
      aliases: [],
    };

    it("delivers everything when there is no OpenAI client", async () => {
      const fileId = await makeFilesRow(employeeCase);
      const result = await runFilesAiPrepare({
        fileId,
        criteria,
        client: null,
        dirs: { documentsDir: "/nope", messagesDir: "/nada" },
      });
      assert.equal(result.operation, "files-ai-skipped");
    });

    it("resolves pending verdicts to keep when submitting throws", async () => {
      const fileId = await makeFilesRow(employeeCase);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "fag-"));
      fs.mkdirSync(path.join(root, "Documents"));
      fs.writeFileSync(
        path.join(root, "Documents", "Document dddddddddddddddd.pdf"),
        "x",
      );
      const client: FilesAiClient = {
        uploadBatchFile: async () => "f",
        createBatch: async () => {
          throw new Error("boom");
        },
        retrieveBatch: async () => ({ status: "in_progress" }),
        readFile: async () => "",
      };
      const result = await runFilesAiPrepare({
        fileId,
        criteria,
        client,
        dirs: {
          documentsDir: path.join(root, "Documents"),
          messagesDir: path.join(root, "Messages"),
        },
        readText: async () => "some text",
      });
      assert.equal(result.operation, "files-ai-prepare-failed");
      const rows = await prisma.filesAiVerdict.findMany({
        where: { file_id: fileId },
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].verdict, "keep");
    });
  });
});
