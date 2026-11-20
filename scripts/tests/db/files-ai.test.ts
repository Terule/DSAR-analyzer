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
  submitQueuedFilesAiRuns,
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

/** Other tests leave submitted runs in the shared DB, so slots are not scarce here. */
const prepare = (input: Parameters<typeof prepareFilesAi>[0]) =>
  prepareFilesAi({ maxActiveJobs: 1_000_000, ...input });

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
    const result = await prepare({
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
    await prepare({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
    });
    const second = await prepare({
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

  it("sends a file with no extractable text to human review without sending it", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(4)}.pdf`]);
    const client = new FakeClient();
    const result = await prepare({
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
    assert.equal(verdict.verdict, "review");
    assert.equal(await isFilesAiSettled(fileId), true);
  });

  it("applies discard, sends garbage and missing ids to human review", async () => {
    const fileId = await makeFile();
    const names = [
      `Document ${H(5)}.pdf`,
      `Document ${H(6)}.pdf`,
      `Document ${H(7)}.pdf`,
    ];
    const dirs = makeDirs(names);
    const client = new FakeClient();
    await prepare({
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
          JSON.stringify({
            relevance: "irrelevant",
            sensitivity: "none",
            reason: "Unrelated memo",
          }),
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
    assert.equal(byId.get(b)?.verdict, "review");
    const missing = client.uploads[0].find(
      (id) => id !== a && id !== b,
    ) as string;
    assert.equal(byId.get(missing)?.verdict, "review");
    assert.equal(
      byId.get(missing)?.reason,
      "No AI result returned; needs human review.",
    );
    const state = await getFilesAiState(fileId);
    assert.equal(state.discards, 1);
    assert.equal(await isFilesAiSettled(fileId), true);
  });

  it("sends everything to human review when the batch fails", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(8)}.pdf`]);
    const client = new FakeClient();
    await prepare({
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
    await prepare({
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
      await prisma.aiBatchRun.count({
        where: { kind: "files", coordinator_id: fileId },
      }),
      0,
    );
    const row = await prisma.filesAiVerdict.findFirstOrThrow({
      where: { file_id: fileId },
    });
    assert.equal(row.batch_run_id, null);
    assert.equal(row.verdict, null);
    // A retry can pick the same file up again.
    client.failCreate = false;
    const retry = await prepare({
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

  it("cuts a run into jobs of at most maxRecordsPerBatch requests", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([1, 2, 3].map((n) => `Document ${H(20 + n)}.pdf`));
    const client = new FakeClient();
    const result = await prepare({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
      maxRecordsPerBatch: 2,
      maxActiveJobs: 1_000,
    });
    assert.equal(result.submittedBatches, 2);
    assert.deepEqual(
      client.uploads.map((upload) => upload.length).sort(),
      [1, 2],
    );
  });

  it("queues jobs beyond the concurrent limit and submits them when a slot frees", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([1, 2, 3].map((n) => `Document ${H(40 + n)}.pdf`));
    const client = new FakeClient();
    const inFlight = await prisma.aiBatchRun.count({
      where: { status: { in: ["submitted", "processing"] } },
    });
    await prepare({
      fileId,
      dirs,
      criteria,
      client,
      readText: textFor,
      batchDir,
      maxRecordsPerBatch: 1,
      maxActiveJobs: inFlight + 1,
    });
    const statuses = async () =>
      (
        await prisma.aiBatchRun.findMany({
          where: { kind: "files", coordinator_id: fileId },
          select: { status: true },
        })
      )
        .map((run) => run.status)
        .sort();
    assert.deepEqual(await statuses(), ["queued", "queued", "submitted"]);
    // The step is not settled while queued runs wait.
    assert.equal(await isFilesAiSettled(fileId), false);

    // No slot yet: nothing moves.
    assert.equal(
      await submitQueuedFilesAiRuns(client, batchDir, inFlight + 1),
      0,
    );
    // The first job finishes; its slot goes to the next queued run.
    await prisma.aiBatchRun.updateMany({
      where: { kind: "files", coordinator_id: fileId, status: "submitted" },
      data: { status: "completed" },
    });
    assert.equal(
      await submitQueuedFilesAiRuns(client, batchDir, inFlight + 1),
      1,
    );
    assert.deepEqual(await statuses(), ["completed", "queued", "submitted"]);
  });

  describe("screening for confidential content", () => {
    async function runOne(
      answer: string,
      options: { text?: string; totalPages?: number } = {},
    ) {
      const fileId = await makeFile();
      const dirs = makeDirs([`Document ${H(50)}.pdf`]);
      const client = new FakeClient();
      await prepare({
        fileId,
        dirs,
        criteria,
        client,
        readSample: async () => ({
          text: options.text ?? "A normal document body.",
          totalPages: options.totalPages ?? 1,
        }),
        batchDir,
      });
      assert.equal(client.uploads.length, 1, "the file must go to the AI");
      const id = client.uploads[0][0];
      client.statuses.set(client.batches[0], {
        status: "completed",
        outputFileId: "out-x",
      });
      client.outputs.set("out-x", outputLine(id, answer));
      await pollFilesAiBatches(fileId, client);
      return prisma.filesAiVerdict.findUniqueOrThrow({ where: { id } });
    }

    const answer = (relevance: string, sensitivity: string) =>
      JSON.stringify({ relevance, sensitivity, reason: "because" });

    it("discards an unprotected salary spreadsheet even when the subject is plainly involved", async () => {
      const row = await runOne(answer("relevant", "payroll_compensation"), {
        // The subject's email is in the text: this used to skip the AI.
        text: "Name | Salary\njw@corp.com | 90000\nAnn | 80000",
      });
      assert.equal(row.verdict, "discard");
      assert.equal(row.sensitivity, "payroll_compensation");
      assert.equal(row.subject_involved, true);
    });

    it("keeps a relevant, non-confidential, normal-sized file", async () => {
      const row = await runOne(answer("relevant", "none"));
      assert.equal(row.verdict, "keep");
    });

    it("sends a relevant, non-confidential large file to human review", async () => {
      const row = await runOne(answer("relevant", "none"), {
        totalPages: 400,
      });
      assert.equal(row.verdict, "review");
      assert.equal(row.large_file, true);
    });

    it("discards a large file that is confidential or irrelevant", async () => {
      assert.equal(
        (
          await runOne(answer("relevant", "legal_privileged"), {
            totalPages: 400,
          })
        ).verdict,
        "discard",
      );
      assert.equal(
        (await runOne(answer("irrelevant", "none"), { totalPages: 400 }))
          .verdict,
        "discard",
      );
    });

    it("sends an unparseable answer to human review", async () => {
      assert.equal((await runOne("not json")).verdict, "review");
    });
  });
});
