import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  type FilesAiClient,
  isFilesAiSettled,
  pollFilesAiBatches,
  prepareFilesAi,
} from "../../../src/lib/files-ai";
import { rereviewFilesAiDiscards } from "../../../src/lib/files-ai-rereview";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const criteria = { name: "Maria Santos", email: "", aliases: [] as string[] };
const created: string[] = [];
const H = (n: number) => n.toString(16).padStart(16, "0");

async function makeFile(): Promise<string> {
  const id = `t-rr-${tag}-${created.length}`;
  await prisma.processedFile.create({
    data: { id, filename: "Files", kind: "files" },
  });
  created.push(id);
  return id;
}

function makeDirs(names: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-"));
  const documentsDir = path.join(root, "Documents");
  const messagesDir = path.join(root, "Messages");
  fs.mkdirSync(documentsDir);
  fs.mkdirSync(messagesDir);
  for (const name of names)
    fs.writeFileSync(path.join(documentsDir, name), "x");
  return { documentsDir, messagesDir };
}

/** A client whose runs look like Bedrock ones: the prefix says which model answered. */
class FakeClient implements FilesAiClient {
  uploads: string[][] = [];
  outputs = new Map<string, string>();
  constructor(private readonly idPrefix: string) {}
  async uploadBatchFile(filePath: string) {
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    this.uploads.push(lines.map((l) => JSON.parse(l).custom_id));
    return `file-${this.uploads.length}`;
  }
  async createBatch() {
    return `${this.idPrefix}${tag}-${crypto.randomUUID().slice(0, 6)}`;
  }
  async retrieveBatch() {
    return { status: "completed", outputFileId: "out" };
  }
  async readFile(fileId: string) {
    return this.outputs.get(fileId) ?? "";
  }
}

const answer = (
  customId: string,
  sensitivity: string,
  confidence: number,
  reason = "r",
) =>
  JSON.stringify({
    custom_id: customId,
    response: {
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                relevance: "relevant",
                sensitivity,
                reason,
                confidence,
              }),
            },
          },
        ],
      },
    },
  });

const textFor = () => Promise.resolve("A normal document body.");

describe("second review of Haiku 4.5 discards", () => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-batches-"));
  after(async () => {
    await prisma.processedFile.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  it("holds doubtful discards, finalises obvious ones, and settles them with the 5.5 answer", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([1, 2, 3, 4, 5].map((n) => `Document ${H(n)}.pdf`));
    const client = new FakeClient("bedrock-batch:");
    await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      mode: "client",
      readText: textFor,
      batchDir,
    });
    const ids = [...client.uploads[0]].sort();
    const [obvious, doubtful, legal, failing, kept] = ids;
    client.outputs.set(
      "out",
      [
        answer(obvious, "payroll_compensation", 2),
        answer(doubtful, "payroll_compensation", 30),
        answer(legal, "legal_privileged", 1),
        answer(failing, "payroll_compensation", 45),
        answer(kept, "none", 97),
      ].join("\n"),
    );
    await pollFilesAiBatches(fileId, client, batchDir);

    const byId = async (id: string) =>
      prisma.filesAiVerdict.findUniqueOrThrow({ where: { id } });
    assert.equal(
      (await byId(obvious)).verdict,
      "discard",
      "obvious discard is final",
    );
    assert.equal((await byId(obvious)).rereview_status, null);
    assert.equal((await byId(kept)).verdict, "keep");
    for (const id of [doubtful, legal, failing]) {
      const row = await byId(id);
      assert.equal(row.verdict, null, "waits for the second opinion");
      assert.equal(row.rereview_status, "pending");
      assert.equal(row.reviewed_by_model, "haiku-4.5");
    }
    assert.equal((await byId(doubtful)).p_keep, 30);
    assert.equal(await isFilesAiSettled(fileId), false);
    const runFile = fs
      .readdirSync(batchDir)
      .filter((f) => f.startsWith("files-ai-"));
    assert.ok(runFile.length > 0, "request file is kept for the second review");

    const settled = await rereviewFilesAiDiscards({
      fileId,
      batchDir,
      converse: async (request) => {
        if (request.customId === failing) throw new Error("boom");
        return request.customId === doubtful
          ? { relevance: "relevant", sensitivity: "none", reason: "own record" }
          : {
              relevance: "relevant",
              sensitivity: "legal_privileged",
              reason: "court order",
            };
      },
    });
    assert.equal(settled, 3);
    assert.equal((await byId(doubtful)).verdict, "keep");
    assert.match((await byId(doubtful)).reason ?? "", /Kept on second review/);
    assert.equal((await byId(legal)).verdict, "discard");
    assert.match(
      (await byId(legal)).reason ?? "",
      /Confirmed on second review/,
    );
    assert.equal(
      (await byId(failing)).verdict,
      "review",
      "a failed second review goes to a person",
    );
    assert.equal((await byId(doubtful)).reviewed_by_model, "haiku-5.5");
    assert.equal((await byId(doubtful)).rereview_status, null);
    assert.equal(await isFilesAiSettled(fileId), true);
    assert.equal(
      fs.readdirSync(batchDir).filter((f) => f.startsWith("files-ai-")).length,
      0,
      "request file is removed once nothing waits",
    );
  });

  it("does not hold discards that Haiku 5.5 (Converse) already made", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(11)}.pdf`]);
    const client = new FakeClient("bedrock-converse:");
    await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      mode: "client",
      readText: textFor,
      batchDir,
    });
    const [id] = client.uploads[0];
    client.outputs.set("out", answer(id, "payroll_compensation", 40));
    await pollFilesAiBatches(fileId, client, batchDir);
    const row = await prisma.filesAiVerdict.findUniqueOrThrow({
      where: { id },
    });
    assert.equal(row.verdict, "discard");
    assert.equal(row.rereview_status, null);
    assert.equal(row.reviewed_by_model, "haiku-5.5");
  });

  it("reclaims a second review left running by a dead worker", async () => {
    const fileId = await makeFile();
    const dirs = makeDirs([`Document ${H(21)}.pdf`]);
    const client = new FakeClient("bedrock-batch:");
    await prepareFilesAi({
      fileId,
      dirs,
      criteria,
      client,
      mode: "client",
      readText: textFor,
      batchDir,
    });
    const [id] = client.uploads[0];
    client.outputs.set("out", answer(id, "legal_privileged", 1));
    await pollFilesAiBatches(fileId, client, batchDir);
    await prisma.filesAiVerdict.update({
      where: { id },
      data: {
        rereview_status: "running",
        rereview_started_at: new Date(Date.now() - 60 * 60_000),
      },
    });
    const settled = await rereviewFilesAiDiscards({
      fileId,
      batchDir,
      converse: async () => ({
        relevance: "relevant",
        sensitivity: "none",
        reason: "fine",
      }),
    });
    assert.equal(settled, 1);
    assert.equal(
      (await prisma.filesAiVerdict.findUniqueOrThrow({ where: { id } }))
        .verdict,
      "keep",
    );
  });
});
