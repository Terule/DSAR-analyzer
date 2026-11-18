import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  type FilesAiClient,
  pollFilesAiBatches,
  runJsonlPath,
} from "../../../src/lib/files-ai";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resubmit-"));
const fileIds: string[] = [];
let n = 0;

class FakeClient implements FilesAiClient {
  created: string[] = [];
  uploaded: string[] = [];
  failCreate = false;
  statuses = new Map<string, string>();
  async uploadBatchFile(filePath: string) {
    this.uploaded.push(fs.readFileSync(filePath, "utf8"));
    return `file-${this.uploaded.length}`;
  }
  async createBatch(_input: string) {
    if (this.failCreate) throw new Error("the service is down");
    const id = `${tag}-new-${this.created.length + 1}`;
    this.created.push(id);
    return id;
  }
  async retrieveBatch(batchId: string) {
    return { status: this.statuses.get(batchId) ?? "in_progress" };
  }
  async readFile() {
    return "";
  }
}

/** A submitted run with one pending item and its request file on disk. */
async function makeRun(attempt = 1) {
  n++;
  const fileId = `t-fr-${tag}-${n}`;
  fileIds.push(fileId);
  await prisma.processedFile.create({
    data: { id: fileId, filename: "Files", kind: "files" },
  });
  const runId = `run-${fileId}`;
  const batchId = `${tag}-old-${n}`;
  await prisma.filesAiBatchRun.create({
    data: {
      id: runId,
      file_id: fileId,
      status: "submitted",
      openai_batch_id: batchId,
      request_count: 1,
      estimated_tokens: 50,
      attempt,
      submitted_at: new Date(),
    },
  });
  const itemId = `${fileId}:mail:abc`;
  await prisma.filesAiVerdict.create({
    data: {
      id: itemId,
      file_id: fileId,
      rel_path: "mail:abc",
      batch_run_id: runId,
    },
  });
  fs.writeFileSync(
    runJsonlPath(runId, dir),
    `${JSON.stringify({ custom_id: itemId })}\n`,
  );
  return { fileId, runId, batchId, itemId };
}

describe("Files AI batch resubmission", () => {
  after(async () => {
    await prisma.processedFile.deleteMany({ where: { id: { in: fileIds } } });
    fs.rmSync(dir, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("resubmits an expired batch once with the same requests", async () => {
    const { fileId, runId, batchId, itemId } = await makeRun();
    const client = new FakeClient();
    client.statuses.set(batchId, "expired");
    await pollFilesAiBatches(fileId, client, dir);

    assert.equal(client.created.length, 1);
    assert.ok(client.uploaded[0].includes(itemId), "same request lines");
    const old = await prisma.filesAiBatchRun.findUniqueOrThrow({
      where: { id: runId },
    });
    assert.equal(old.status, "failed");
    const runs = await prisma.filesAiBatchRun.findMany({
      where: { file_id: fileId, status: "submitted" },
    });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].attempt, 2);
    assert.equal(runs[0].openai_batch_id, client.created[0]);
    const item = await prisma.filesAiVerdict.findUniqueOrThrow({
      where: { id: itemId },
    });
    assert.equal(item.verdict, null, "still waiting on the new batch");
    assert.equal(item.batch_run_id, runs[0].id);
    assert.equal(fs.existsSync(runJsonlPath(runId, dir)), false);
    assert.equal(fs.existsSync(runJsonlPath(runs[0].id, dir)), true);
  });

  it("does not resubmit a second time: the files go to human review", async () => {
    const { fileId, itemId, batchId } = await makeRun(2);
    const client = new FakeClient();
    client.statuses.set(batchId, "failed");
    await pollFilesAiBatches(fileId, client, dir);

    assert.equal(client.created.length, 0);
    const item = await prisma.filesAiVerdict.findUniqueOrThrow({
      where: { id: itemId },
    });
    assert.equal(item.verdict, "review");
  });

  it("sends the files to human review when the resubmission itself fails", async () => {
    const { fileId, runId, itemId, batchId } = await makeRun();
    const client = new FakeClient();
    client.statuses.set(batchId, "cancelled");
    client.failCreate = true;
    await pollFilesAiBatches(fileId, client, dir);

    const item = await prisma.filesAiVerdict.findUniqueOrThrow({
      where: { id: itemId },
    });
    assert.equal(item.verdict, "review");
    const runs = await prisma.filesAiBatchRun.findMany({
      where: { file_id: fileId },
    });
    assert.equal(runs.length, 1, "no orphan claiming run is left behind");
    assert.equal(runs[0].id, runId);
    assert.equal(runs[0].status, "failed");
  });

  it("goes straight to human review when the request file is gone", async () => {
    const { fileId, runId, itemId, batchId } = await makeRun();
    fs.rmSync(runJsonlPath(runId, dir), { force: true });
    const client = new FakeClient();
    client.statuses.set(batchId, "expired");
    await pollFilesAiBatches(fileId, client, dir);

    assert.equal(client.created.length, 0);
    assert.equal(
      (await prisma.filesAiVerdict.findUniqueOrThrow({ where: { id: itemId } }))
        .verdict,
      "review",
    );
  });
});
