import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, describe, it } from "node:test";
import type { FilesAiClient } from "../../../src/lib/files-ai";
import {
  filesAiWorkRemains,
  pollFilesAiRuns,
} from "../../../src/lib/files-ai-poll";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const fileIds: string[] = [];
let n = 0;

async function makeRun(opts: { ageMinutes: number; batchId: string }) {
  n++;
  const fileId = `t-fap-${tag}-${n}`;
  fileIds.push(fileId);
  await prisma.processedFile.create({
    data: { id: fileId, filename: "Files", kind: "files" },
  });
  const runId = `run-${fileId}`;
  await prisma.filesAiBatchRun.create({
    data: {
      id: runId,
      file_id: fileId,
      status: "submitted",
      openai_batch_id: `${tag}-${opts.batchId}`,
      submitted_at: new Date(Date.now() - opts.ageMinutes * 60_000),
    },
  });
  await prisma.filesAiVerdict.create({
    data: {
      id: `${fileId}:Documents/Document aaaaaaaaaaaaaaaa.pdf`,
      file_id: fileId,
      rel_path: "Documents/Document aaaaaaaaaaaaaaaa.pdf",
      batch_run_id: runId,
    },
  });
  return { fileId, runId };
}

const doneClient: FilesAiClient = {
  uploadBatchFile: async () => "f",
  createBatch: async () => "b",
  retrieveBatch: async () => ({ status: "completed", outputFileId: "out" }),
  readFile: async () => "",
};
const noKey = async () => {
  throw new Error("Configure the OpenAI API key in Settings.");
};

describe("Files AI poller", () => {
  after(async () => {
    await prisma.processedFile.deleteMany({ where: { id: { in: fileIds } } });
    await prisma.$disconnect();
  });

  it("polls submitted runs and applies their results", async () => {
    const { fileId } = await makeRun({ ageMinutes: 1, batchId: "a" });
    const polled = await pollFilesAiRuns(async () => doneClient, fileIds);
    assert.ok(polled >= 1);
    const row = await prisma.filesAiVerdict.findFirstOrThrow({
      where: { file_id: fileId },
    });
    assert.equal(row.verdict, "review"); // empty output: missing results need a person
  });

  it("leaves a recent run alone when there is no OpenAI key", async () => {
    const { fileId, runId } = await makeRun({ ageMinutes: 1, batchId: "b" });
    await pollFilesAiRuns(noKey, fileIds);
    const run = await prisma.filesAiBatchRun.findUniqueOrThrow({
      where: { id: runId },
    });
    assert.equal(run.status, "submitted");
    assert.equal(
      (
        await prisma.filesAiVerdict.findFirstOrThrow({
          where: { file_id: fileId },
        })
      ).verdict,
      null,
    );
  });

  it("gives up on a stale run when there is still no key, and sends its files to human review", async () => {
    const { fileId, runId } = await makeRun({ ageMinutes: 90, batchId: "c" });
    await pollFilesAiRuns(noKey, fileIds);
    const run = await prisma.filesAiBatchRun.findUniqueOrThrow({
      where: { id: runId },
    });
    assert.equal(run.status, "failed");
    assert.equal(
      (
        await prisma.filesAiVerdict.findFirstOrThrow({
          where: { file_id: fileId },
        })
      ).verdict,
      "review",
    );
  });

  it("gives up on a run stuck in claiming and sends its files to human review", async () => {
    n++;
    const fileId = `t-fap-${tag}-${n}`;
    fileIds.push(fileId);
    await prisma.processedFile.create({
      data: { id: fileId, filename: "Files", kind: "files" },
    });
    const stale = `run-stale-${fileId}`;
    const fresh = `run-fresh-${fileId}`;
    await prisma.filesAiBatchRun.createMany({
      data: [
        {
          id: stale,
          file_id: fileId,
          status: "claiming",
          created_at: new Date(Date.now() - 90 * 60_000),
        },
        { id: fresh, file_id: fileId, status: "claiming" },
      ],
    });
    await prisma.filesAiVerdict.createMany({
      data: [
        {
          id: `${fileId}:Documents/Document aaaaaaaaaaaaaaaa.pdf`,
          file_id: fileId,
          rel_path: "Documents/Document aaaaaaaaaaaaaaaa.pdf",
          batch_run_id: stale,
        },
        {
          id: `${fileId}:Documents/Document bbbbbbbbbbbbbbbb.pdf`,
          file_id: fileId,
          rel_path: "Documents/Document bbbbbbbbbbbbbbbb.pdf",
          batch_run_id: fresh,
        },
      ],
    });
    await pollFilesAiRuns(async () => doneClient, fileIds);
    const runs = await prisma.filesAiBatchRun.findMany({
      where: { file_id: fileId },
    });
    assert.equal(runs.find((r) => r.id === stale)?.status, "failed");
    assert.equal(runs.find((r) => r.id === fresh)?.status, "claiming");
    const rows = await prisma.filesAiVerdict.findMany({
      where: { file_id: fileId },
    });
    assert.equal(rows.find((r) => r.batch_run_id === stale)?.verdict, "review");
    assert.equal(rows.find((r) => r.batch_run_id === fresh)?.verdict, null);
  });

  it("reports remaining work while a run is active", async () => {
    await makeRun({ ageMinutes: 1, batchId: "d" });
    assert.equal(await filesAiWorkRemains(), true);
  });
});
