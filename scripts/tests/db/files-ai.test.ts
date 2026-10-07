import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type FilesAiClient,
  getFilesAiState,
  isFilesAiSettled,
  pollFilesAiBatches,
  prepareFilesAi,
} from "../../../src/lib/files-ai";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const criteria = {
  name: "Jonathan Wheeler",
  email: "jw@corp.com",
  aliases: ["Jon W"],
};
const created: string[] = [];

const H = (n: number) => n.toString(16).padStart(16, "0");

async function makeFile(): Promise<string> {
  const id = `t-fai-${tag}-${created.length}`;
  await prisma.processedFile.create({
    data: { id, filename: "Files", kind: "files" },
  });
  created.push(id);
  return id;
}

function makeDirs(names: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fai-"));
  const documentsDir = path.join(root, "Documents");
  const messagesDir = path.join(root, "Messages");
  fs.mkdirSync(documentsDir);
  fs.mkdirSync(messagesDir);
  for (const name of names)
    fs.writeFileSync(path.join(documentsDir, name), "x");
  return { documentsDir, messagesDir };
}

function outputLine(customId: string, content: string) {
  return JSON.stringify({
    custom_id: customId,
    response: { body: { choices: [{ message: { content } }] } },
  });
}

let clientCounter = 0;

class FakeClient implements FilesAiClient {
  readonly prefix = `${tag}-c${++clientCounter}-`;
  uploads: string[][] = []; // custom_ids per uploaded batch file
  batches: string[] = [];
  statuses = new Map<
    string,
    { status: string; outputFileId?: string | null }
  >();
  outputs = new Map<string, string>();
  failCreate = false;

  async uploadBatchFile(filePath: string) {
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    this.uploads.push(lines.map((l) => JSON.parse(l).custom_id));
    return `file-${this.uploads.length}`;
  }
  async createBatch(_inputFileId: string) {
    if (this.failCreate) throw new Error("boom");
    const id = `${this.prefix}batch-${this.batches.length + 1}`;
    this.batches.push(id);
    return id;
  }
  async retrieveBatch(batchId: string) {
    return this.statuses.get(batchId) ?? { status: "in_progress" };
  }
  async readFile(fileId: string) {
    return this.outputs.get(fileId) ?? "";
  }
}

const textFor = (_abs: string) => Promise.resolve("A normal document body.");

describe("Files AI", () => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), "fai-batches-"));
  before(() => undefined);
  after(async () => {
    await prisma.processedFile.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  it("queues each candidate once and submits one batch", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(1)}.pdf`, `Document ${H(2)}.pdf`]);
    const client = new FakeClient();
    const result = await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
    });
    assert.equal(result.candidates, 2);
    assert.equal(result.queued, 2);
    assert.equal(result.submittedBatches, 1);
    assert.equal(client.uploads[0].length, 2);
    assert.equal((await getFilesAiState(fileId)).activeRuns, 1);
    assert.equal(await isFilesAiSettled(fileId), false);
  });

  it("is idempotent: a second prepare submits nothing", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(3)}.pdf`]);
    const client = new FakeClient();
    await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
    });
    const second = await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
    });
    assert.equal(second.queued, 0);
    assert.equal(second.submittedBatches, 0);
    assert.equal(client.batches.length, 1);
  });

  it("keeps a file with no extractable text without sending it", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(4)}.pdf`]);
    const client = new FakeClient();
    const result = await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: async () => "  ",
      batchDir,
    });
    assert.equal(result.keptNoText, 1);
    assert.equal(client.batches.length, 0);
    const verdict = await prisma.filesAiVerdict.findFirstOrThrow({
      where: { file_id: fileId },
    });
    assert.equal(verdict.verdict, "keep");
    assert.equal(await isFilesAiSettled(fileId), true);
  });

  it("applies discard, keeps garbage, and keeps ids missing from the output", async () => {
    const fileId = await makeFile();
    const names = [
      `Document ${H(5)}.pdf`,
      `Document ${H(6)}.pdf`,
      `Document ${H(7)}.pdf`,
    ];
    const dirs = makeDirs(names);
    const client = new FakeClient();
    await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
    });
    const [a, b] = client.uploads[0].sort();
    client.statuses.set(client.batches[0], {
      status: "completed",
      outputFileId: "out-1",
    });
    client.outputs.set(
      "out-1",
      [
        outputLine(
          a,
          JSON.stringify({ decision: "discard", reason: "Unrelated memo" }),
        ),
        outputLine(b, "this is not json"),
      ].join("\n"),
    );
    await pollFilesAiBatches(fileId, client);
    const rows = await prisma.filesAiVerdict.findMany({
      where: { file_id: fileId },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(a)?.verdict, "discard");
    assert.equal(byId.get(a)?.reason, "Unrelated memo");
    assert.equal(byId.get(b)?.verdict, "keep");
    const missing = client.uploads[0].find(
      (id) => id !== a && id !== b,
    ) as string;
    assert.equal(byId.get(missing)?.verdict, "keep");
    assert.equal(byId.get(missing)?.reason, "No AI result returned; kept.");
    const state = await getFilesAiState(fileId);
    assert.equal(state.discards, 1);
    assert.equal(await isFilesAiSettled(fileId), true);
  });

  it("resolves everything to keep when the batch fails", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(8)}.pdf`]);
    const client = new FakeClient();
    await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
    });
    client.statuses.set(client.batches[0], { status: "failed" });
    await pollFilesAiBatches(fileId, client);
    const state = await getFilesAiState(fileId);
    assert.equal(state.pending, 0);
    assert.equal(state.discards, 0);
    assert.equal(state.failedRuns, 1);
    assert.equal(await isFilesAiSettled(fileId), true);
  });

  it("keeps everything when a batch completes without an output file", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(9)}.pdf`]);
    const client = new FakeClient();
    await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
    });
    client.statuses.set(client.batches[0], {
      status: "completed",
      outputFileId: null,
    });
    await pollFilesAiBatches(fileId, client);
    assert.equal((await getFilesAiState(fileId)).pending, 0);
  });

  it("leaves no run behind and releases the claim when submit fails", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(10)}.pdf`]);
    const client = new FakeClient();
    client.failCreate = true;
    await assert.rejects(
      prepareFilesAi({
        fileId,
        dirs,
        criteria,
        client,
        readText: textFor,
        batchDir,
      }),
      /boom/,
    );
    assert.equal(
      await prisma.filesAiBatchRun.count({ where: { file_id: fileId } }),
      0,
    );
    const row = await prisma.filesAiVerdict.findFirstOrThrow({
      where: { file_id: fileId },
    });
    assert.equal(row.batch_run_id, null);
    assert.equal(row.verdict, null);
    // A retry can pick the same file up again.
    client.failCreate = false;
    const retry = await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
    });
    // The unclaimed pending row is picked up again instead of waiting forever.
    assert.equal(retry.queued, 1);
    assert.equal(retry.submittedBatches, 1);
    assert.equal(
      await prisma.filesAiVerdict.count({ where: { file_id: fileId } }),
      1,
    );
  });

  it("splits candidates across batches by the token budget", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([1, 2, 3].map((n) => `Document ${H(20 + n)}.pdf`));
    const client = new FakeClient();
    const longText = async () => "word ".repeat(200);
    const result = await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: longText,
      batchDir,
      maxTokensPerBatch: 800,
    });
    assert.ok(
      result.submittedBatches >= 2,
      `batches=${result.submittedBatches}`,
    );
    assert.equal(client.uploads.flat().length, 3);
  });

  it("keeps a single request that exceeds the whole budget", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(30)}.pdf`]);
    const client = new FakeClient();
    const result = await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
      maxTokensPerBatch: 50,
    });
    assert.equal(result.submittedBatches, 0);
    const row = await prisma.filesAiVerdict.findFirstOrThrow({
      where: { file_id: fileId },
    });
    assert.equal(row.verdict, "keep");
    assert.equal(row.reason, "Too large to review; kept.");
  });
});
