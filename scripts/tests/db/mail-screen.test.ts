import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { renderEmailAttachments } from "../../../src/lib/converter";
import {
  type FilesAiClient,
  pollFilesAiBatches,
} from "../../../src/lib/files-ai";
import {
  attachmentKey,
  bodyKey,
  getMailScreenVerdicts,
  settleMailScreens,
  startMailScreen,
} from "../../../src/lib/mail-screen";
import {
  getAiBatchSettings,
  updateAiBatchSettings,
} from "../../../src/lib/pipeline-settings";
import { prisma } from "../../../src/lib/prisma";
import { getPstWorkFolder } from "../../../src/lib/pst-artifacts";

const tag = crypto.randomUUID().slice(0, 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mscreen-"));
const staging = path.join(root, "staging");
const extracted = path.join(root, "extracted");
process.env.STAGING_PATH = staging;
process.env.EXTRACTED_PATH = extracted;

const cases: string[] = [];
const fileIds: string[] = [];
let counter = 0;
let originalEnabled = true;

/** A one-page PDF whose text layer is `text`. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function eml(input: {
  subject: string;
  text: string;
  attachments?: Array<{ name: string; content: Buffer }>;
}): string {
  const boundary = "BOUNDARY";
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${input.text}\r\n`,
    ...(input.attachments ?? []).map(
      (a) =>
        `--${boundary}\r\nContent-Type: application/pdf; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${a.content.toString("base64")}\r\n`,
    ),
    `--${boundary}--\r\n`,
  ];
  return [
    "From: ann@corp.com",
    "To: jw@corp.com",
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts,
  ].join("\r\n");
}

class FakeClient implements FilesAiClient {
  uploads: string[][] = [];
  batches: string[] = [];
  statuses = new Map<
    string,
    { status: string; outputFileId?: string | null }
  >();
  outputs = new Map<string, string>();
  async uploadBatchFile(filePath: string) {
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    this.uploads.push(lines.map((l) => JSON.parse(l).custom_id));
    return `file-${this.uploads.length}`;
  }
  async createBatch(_input: string) {
    const id = `${tag}-batch-${counter}-${this.batches.length + 1}`;
    this.batches.push(id);
    return id;
  }
  async retrieveBatch(batchId: string) {
    return this.statuses.get(batchId) ?? { status: "in_progress" };
  }
  async readFile(fileId: string) {
    return this.outputs.get(fileId) ?? "";
  }

  /** Answers every submitted request using `answer(customId)`. */
  answer(answer: (customId: string) => object) {
    this.statuses.set(this.batches[0], {
      status: "completed",
      outputFileId: "out",
    });
    this.outputs.set(
      "out",
      this.uploads[0]
        .map((id) =>
          JSON.stringify({
            custom_id: id,
            response: {
              body: {
                choices: [{ message: { content: JSON.stringify(answer(id)) } }],
              },
            },
          }),
        )
        .join("\n"),
    );
  }
}

const verdictOf = (relevance: string, sensitivity: string) => ({
  relevance,
  sensitivity,
  reason: "because",
});

interface Setup {
  id: string;
  folders: { selected: string; discarded: string; review: string };
  /** Full, globally unique email hash for a short test name. */
  h: (short: string) => string;
}

async function setup(
  caseType: "employee" | "client",
  emails: Array<{
    hash: string;
    body: string;
    attachments?: Array<{ name: string; content: Buffer }>;
  }>,
): Promise<Setup> {
  counter++;
  const caseId = `t-ms-case-${tag}-${counter}`;
  await prisma.managedCase.create({
    data: {
      id: caseId,
      name: `ZZ-${caseId}`,
      subject_name: "Jonathan Wheeler",
      subject_email: "jw@corp.com",
      case_type: caseType,
    },
  });
  cases.push(caseId);
  const requestId = `t-ms-req-${tag}-${counter}`;
  await prisma.caseRequest.create({
    data: {
      id: requestId,
      case_id: caseId,
      name: `R${counter}`,
      scope: "mail",
      status: "running",
      staging_path: path.join(staging, `ZZ-${caseId}`, `R${counter}`),
      deliverable_path: path.join(extracted, `ZZ-${caseId}`, `R${counter}`),
    },
  });
  const id = `t-ms-file-${tag}-${counter}`;
  const filepath = path.join(
    staging,
    `ZZ-${caseId}`,
    `R${counter}`,
    "PST",
    "a.pst",
  );
  await prisma.processedFile.create({
    data: {
      id,
      filename: "a.pst",
      kind: "pst",
      filepath,
      case_request_id: requestId,
      ai_status: "processing",
    },
  });
  fileIds.push(id);

  const unique = path.join(
    getPstWorkFolder({
      fileId: id,
      filepath,
      stagingPath: staging,
      extractedPath: extracted,
    }),
    ".unique-emails",
  );
  const folders = {
    selected: path.join(unique, "selected"),
    discarded: path.join(unique, "discarded"),
    review: path.join(unique, "review"),
  };
  fs.mkdirSync(folders.selected, { recursive: true });
  const prefix = `${tag}-${counter}-`;
  for (const email of emails) {
    fs.writeFileSync(
      path.join(folders.selected, `${prefix}${email.hash}.eml`),
      eml({
        subject: `Subject ${email.hash}`,
        text: email.body,
        attachments: email.attachments,
      }),
    );
    await prisma.email.create({
      data: {
        id: crypto.randomUUID(),
        file_id: id,
        email_hash: `${prefix}${email.hash}`,
        is_duplicate: 0,
        ai_decision: "keep",
      },
    });
  }
  return { id, folders, h: (short) => `${prefix}${short}` };
}

describe("Mail screening before Render", () => {
  before(async () => {
    originalEnabled = (await getAiBatchSettings()).filesAiEnabled ?? true;
    await updateAiBatchSettings({
      ...(await getAiBatchSettings()),
      filesAiEnabled: true,
    });
  });
  after(async () => {
    await updateAiBatchSettings({
      ...(await getAiBatchSettings()),
      filesAiEnabled: originalEnabled,
    });
    await prisma.email.deleteMany({
      where: { email_hash: { startsWith: `${tag}-` } },
    });
    await prisma.processedFile.deleteMany({ where: { id: { in: fileIds } } });
    await prisma.caseRequest.deleteMany({ where: { case_id: { in: cases } } });
    await prisma.managedCase.deleteMany({ where: { id: { in: cases } } });
    fs.rmSync(root, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  const payroll = pdf("Payroll Ann 80000 Bob 90000 for Jonathan Wheeler team");
  const memo = pdf("Memo to Jonathan Wheeler about the project");

  it("never settles a screening that is still being prepared", async () => {
    const { id } = await setup("client", [{ hash: "p1", body: "hello" }]);
    // What startMailScreen leaves while it reads the emails: no items yet.
    await prisma.processedFile.update({
      where: { id },
      data: { mail_screen_status: "preparing", ai_status: "batch_ready" },
    });
    assert.deepEqual(await settleMailScreens(), [], "must wait for the items");
    const row = await prisma.processedFile.findUniqueOrThrow({
      where: { id },
    });
    assert.equal(row.mail_screen_status, "preparing");
    assert.equal(row.ai_status, "batch_ready");
  });

  it("screens attachments, holds the AI phase open, then releases Render", async () => {
    const { id } = await setup("employee", [
      {
        hash: "a1",
        body: "see attached",
        attachments: [
          { name: "payroll.pdf", content: payroll },
          { name: "memo.pdf", content: memo },
        ],
      },
    ]);
    const client = new FakeClient();
    assert.equal(await startMailScreen(id, 1234, client), "screening");

    // The coordinator stays "batch_ready" so the UI and restarts keep tracking it.
    let row = await prisma.processedFile.findUniqueOrThrow({ where: { id } });
    assert.equal(row.ai_status, "batch_ready");
    assert.equal(row.mail_screen_status, "screening");
    assert.equal(
      client.uploads[0].length,
      2,
      "one request per distinct attachment",
    );
    assert.deepEqual(await settleMailScreens(), [], "nothing to settle yet");

    client.answer((customId) =>
      customId === `${id}:${attachmentKey(payroll)}`
        ? verdictOf("relevant", "payroll_compensation")
        : verdictOf("relevant", "none"),
    );
    await pollFilesAiBatches(id, client);
    assert.deepEqual(await settleMailScreens(), [id]);

    row = await prisma.processedFile.findUniqueOrThrow({ where: { id } });
    assert.equal(row.ai_status, "completed");
    assert.equal(row.mail_screen_status, "done");
    assert.equal(Number(row.ai_duration_ms), 1234);

    const verdicts = await getMailScreenVerdicts(id);
    assert.equal(verdicts?.get(attachmentKey(payroll))?.verdict, "discard");
    assert.equal(verdicts?.get(attachmentKey(memo))?.verdict, "keep");

    // Render only delivers what the screening kept.
    const out = fs.mkdtempSync(path.join(root, "out-"));
    const reviewDir = path.join(root, "review-out");
    await renderEmailAttachments({
      attachments: [
        { filename: "payroll.pdf", content: payroll },
        { filename: "memo.pdf", content: memo },
      ] as never,
      currentBaseName: "Email 0001",
      outputDir: out,
      criteria: ["jonathan wheeler"],
      screen: verdicts,
      reviewDir,
    });
    assert.deepEqual(fs.readdirSync(out), ["Email 0001 Attachment 1.pdf"]);
    assert.equal(fs.existsSync(reviewDir), false);
  });

  it("judges a file mailed many times once", async () => {
    const { id } = await setup("employee", [
      {
        hash: "d1",
        body: "x",
        attachments: [{ name: "memo.pdf", content: memo }],
      },
      {
        hash: "d2",
        body: "y",
        attachments: [{ name: "same.pdf", content: memo }],
      },
    ]);
    const client = new FakeClient();
    await startMailScreen(id, 0, client);
    assert.equal(client.uploads[0].length, 1);
  });

  it("sends an attachment the AI could not read to human review, never to delivery", async () => {
    const { id } = await setup("employee", [
      {
        hash: "r1",
        body: "x",
        attachments: [{ name: "memo.pdf", content: memo }],
      },
    ]);
    const client = new FakeClient();
    await startMailScreen(id, 0, client);
    // The first failure is resubmitted once; only a second one sends the
    // attachment to a person.
    client.statuses.set(client.batches[0], { status: "failed" });
    await pollFilesAiBatches(id, client);
    assert.equal(client.batches.length, 2, "resubmitted once");
    assert.deepEqual(await settleMailScreens(), [], "still waiting");
    client.statuses.set(client.batches[1], { status: "failed" });
    await pollFilesAiBatches(id, client);
    await settleMailScreens();

    const verdicts = await getMailScreenVerdicts(id);
    assert.equal(verdicts?.get(attachmentKey(memo))?.verdict, "review");

    const out = fs.mkdtempSync(path.join(root, "out-"));
    const reviewDir = path.join(root, `review-${counter}`);
    await renderEmailAttachments({
      attachments: [{ filename: "memo.pdf", content: memo }] as never,
      currentBaseName: "Email 0001",
      outputDir: out,
      criteria: ["jonathan wheeler"],
      screen: verdicts,
      reviewDir,
    });
    assert.deepEqual(fs.readdirSync(out), []);
    assert.deepEqual(fs.readdirSync(reviewDir), [
      "Email 0001 Attachment 1.pdf",
    ]);
  });

  it("sends everything to human review when there is no OpenAI key", async () => {
    const { id } = await setup("employee", [
      {
        hash: "n1",
        body: "x",
        attachments: [{ name: "memo.pdf", content: memo }],
      },
    ]);
    assert.equal(await startMailScreen(id, 0, null), "completed");
    const verdicts = await getMailScreenVerdicts(id);
    assert.equal(verdicts?.get(attachmentKey(memo))?.verdict, "review");
  });

  it("treats an attachment that was never screened as needing review", async () => {
    const { id } = await setup("employee", [{ hash: "m1", body: "x" }]);
    await startMailScreen(id, 0, new FakeClient());
    const verdicts = await getMailScreenVerdicts(id);
    const out = fs.mkdtempSync(path.join(root, "out-"));
    const reviewDir = path.join(root, `review-${counter}`);
    await renderEmailAttachments({
      attachments: [{ filename: "memo.pdf", content: memo }] as never,
      currentBaseName: "Email 0001",
      outputDir: out,
      criteria: ["jonathan wheeler"],
      screen: verdicts,
      reviewDir,
    });
    assert.deepEqual(fs.readdirSync(out), []);
    assert.deepEqual(fs.readdirSync(reviewDir), [
      "Email 0001 Attachment 1.pdf",
    ]);
  });

  it("completes the AI phase at once when there is nothing to screen", async () => {
    const { id } = await setup("employee", [
      { hash: "e1", body: "no attachments" },
    ]);
    assert.equal(await startMailScreen(id, 0, new FakeClient()), "completed");
    const row = await prisma.processedFile.findUniqueOrThrow({ where: { id } });
    assert.equal(row.ai_status, "completed");
    assert.equal(row.mail_screen_status, "done");
  });

  it("does nothing when the AI screening setting is off", async () => {
    const settings = await getAiBatchSettings();
    await updateAiBatchSettings({ ...settings, filesAiEnabled: false });
    try {
      const { id } = await setup("employee", [
        {
          hash: "o1",
          body: "x",
          attachments: [{ name: "memo.pdf", content: memo }],
        },
      ]);
      assert.equal(await startMailScreen(id, 0, new FakeClient()), "disabled");
      const row = await prisma.processedFile.findUniqueOrThrow({
        where: { id },
      });
      assert.equal(row.ai_status, "completed");
      assert.equal(row.mail_screen_status, "none");
      assert.equal(await getMailScreenVerdicts(id), null);
    } finally {
      await updateAiBatchSettings({ ...settings, filesAiEnabled: true });
    }
  });

  it("screens email bodies in client cases and removes the confidential ones", async () => {
    const { id, folders, h } = await setup("client", [
      { hash: "c-ok", body: "Lunch on friday" },
      { hash: "c-secret", body: "Salary list: Ann 80000, Bob 90000" },
      { hash: "c-unsure", body: "hard to say" },
    ]);
    const client = new FakeClient();
    assert.equal(await startMailScreen(id, 0, client), "screening");
    assert.equal(client.uploads[0].length, 3);
    client.answer((customId) => {
      if (customId === `${id}:${bodyKey(h("c-secret"))}`)
        return verdictOf("relevant", "payroll_compensation");
      if (customId === `${id}:${bodyKey(h("c-unsure"))}`)
        return { nonsense: true };
      return verdictOf("relevant", "none");
    });
    await pollFilesAiBatches(id, client);
    await settleMailScreens();

    assert.equal(
      fs.existsSync(path.join(folders.selected, `${h("c-ok")}.eml`)),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(folders.selected, `${h("c-secret")}.eml`)),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(folders.discarded, `${h("c-secret")}.eml`)),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(folders.selected, `${h("c-unsure")}.eml`)),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(folders.review, `${h("c-unsure")}.eml`)),
      true,
    );

    const decisions = Object.fromEntries(
      (
        await prisma.email.findMany({
          where: { file_id: id },
          select: { email_hash: true, ai_decision: true },
        })
      ).map((e) => [e.email_hash.slice(h("").length), e.ai_decision]),
    );
    assert.deepEqual(decisions, {
      "c-ok": "keep",
      "c-secret": "discard",
      "c-unsure": "review",
    });
    const row = await prisma.processedFile.findUniqueOrThrow({ where: { id } });
    assert.equal(row.ai_discarded_count, 1);
    assert.equal(row.ai_status, "completed");
  });
});
