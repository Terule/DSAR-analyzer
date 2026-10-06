import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { convertToPdfBatch } from "../../../src/lib/converter";
import { prisma } from "../../../src/lib/prisma";
import { getPstWorkFolder } from "../../../src/lib/pst-artifacts";

const tag = crypto.randomUUID().slice(0, 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "render-guard-"));
const staging = path.join(root, "Staging");
const results = path.join(root, "Results");
process.env.STAGING_PATH = staging;
process.env.EXTRACTED_PATH = results;
const caseName = `ZZ-RG-${tag}`;
const caseId = `t-rg-${tag}`;
let counter = 0;

function eml(opts: { subject: string; to?: string }): string {
  return [
    'From: "Sender" <sender@example.com>',
    ...(opts.to === undefined
      ? ['To: "Receiver" <receiver@example.com>']
      : opts.to
        ? [`To: ${opts.to}`]
        : []),
    `Subject: ${opts.subject}`,
    "Date: Mon, 06 Oct 2025 10:00:00 +0000",
    `Message-ID: <${crypto.randomUUID()}@example.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of ${opts.subject}`,
    "",
  ].join("\r\n");
}

async function setup() {
  counter++;
  const requestName = `R${counter}`;
  const requestStaging = path.join(staging, caseName, requestName);
  const deliverable = path.join(results, caseName, requestName);
  fs.mkdirSync(path.join(requestStaging, "PST"), { recursive: true });
  fs.mkdirSync(path.join(deliverable, "Emails"), { recursive: true });
  const requestId = `t-rg-req-${tag}-${counter}`;
  await prisma.caseRequest.create({
    data: {
      id: requestId,
      case_id: caseId,
      name: requestName,
      scope: "mail",
      staging_path: requestStaging,
      deliverable_path: deliverable,
    },
  });
  const filepath = path.join(requestStaging, "PST", "a.pst");
  const fileId = `t-rg-file-${tag}-${counter}`;
  await prisma.processedFile.create({
    data: {
      id: fileId,
      filepath,
      kind: "pst",
      case_request_id: requestId,
      subject_name: "Test Subject",
      status: "completed",
      ai_status: "completed",
      pdf_status: "pending",
    },
  });
  const work = getPstWorkFolder({
    fileId,
    filepath,
    stagingPath: staging,
    extractedPath: results,
  });
  const unique = path.join(work, ".unique-emails");
  const selected = path.join(unique, "selected");
  fs.mkdirSync(selected, { recursive: true });
  fs.mkdirSync(path.join(unique, "raw-emails"), { recursive: true });
  return {
    fileId,
    requestId,
    work,
    selected,
    ledger: path.join(unique, "render-ledger.jsonl"),
    emails: path.join(deliverable, "Emails"),
    add: (hash: string, content: string) =>
      fs.writeFileSync(path.join(selected, `${hash}.eml`), content),
    render: () => convertToPdfBatch(fileId, results),
    status: async () =>
      (await prisma.processedFile.findUniqueOrThrow({ where: { id: fileId } }))
        .pdf_status,
  };
}

describe("Render numbering and completeness", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: caseName,
        subject_name: "Test Subject",
        subject_email: "subject@example.com",
        case_type: "client",
      },
    });
  });
  after(async () => {
    await prisma.processedFile.deleteMany({
      where: { case_request: { case_id: caseId } },
    });
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("renders every email, numbers them 1..N and cleans up when complete", async () => {
    const t = await setup();
    t.add("aaa", eml({ subject: "One" }));
    t.add("bbb", eml({ subject: "Two" }));
    t.add("ccc", eml({ subject: "Three" }));
    await t.render();
    assert.equal(await t.status(), "completed");
    const numbers = fs
      .readdirSync(t.emails)
      .map((f) => /^Email (\d+)\.pdf$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2, 3]);
    assert.equal(
      fs.existsSync(t.work),
      false,
      "work folder is removed once complete",
    );
  });

  it("a retry numbers leftover emails after the ones already delivered", async () => {
    const t = await setup();
    // The dying run had delivered Email 0001 and 0002 and deleted their sources.
    fs.writeFileSync(path.join(t.emails, "Email 0001.pdf"), "ORIGINAL-1");
    fs.writeFileSync(path.join(t.emails, "Email 0002.pdf"), "ORIGINAL-2");
    fs.writeFileSync(
      t.ledger,
      `${JSON.stringify({ h: "aaa", n: 1 })}
${JSON.stringify({ h: "bbb", n: 2 })}
`,
    );
    // Only the leftover is still on disk.
    t.add("ccc", eml({ subject: "Leftover" }));
    await t.render();
    assert.equal(await t.status(), "completed");
    assert.equal(
      fs.readFileSync(path.join(t.emails, "Email 0001.pdf"), "utf8"),
      "ORIGINAL-1",
    );
    assert.equal(
      fs.readFileSync(path.join(t.emails, "Email 0002.pdf"), "utf8"),
      "ORIGINAL-2",
    );
    const third = path.join(t.emails, "Email 0003.pdf");
    assert.ok(
      fs.existsSync(third) && fs.statSync(third).size > 100,
      "the leftover got its own PDF",
    );
  });

  it("treats an email with no recipient as skipped on purpose, not lost", async () => {
    const t = await setup();
    t.add("aaa", eml({ subject: "Has recipient" }));
    t.add("bbb", eml({ subject: "No recipient", to: "" }));
    await t.render();
    assert.equal(await t.status(), "completed");
    const pdfs = fs
      .readdirSync(t.emails)
      .filter((f) => /^Email \d+\.pdf$/.test(f));
    assert.equal(pdfs.length, 1);
  });

  it("fails loudly, keeping the working files, when an email ends with no PDF", async () => {
    const t = await setup();
    t.add("aaa", eml({ subject: "Fine" }));
    t.add("bbb", eml({ subject: "Broken" }));
    // Email 0002 already exists but is empty (a half-written PDF from a crash).
    fs.writeFileSync(path.join(t.emails, "Email 0002.pdf"), "");
    fs.writeFileSync(
      t.ledger,
      `${JSON.stringify({ h: "bbb", n: 2 })}
`,
    );
    await t.render();
    assert.equal(await t.status(), "failed");
    assert.equal(
      fs.existsSync(t.work),
      true,
      "work folder is kept for the retry",
    );
    assert.equal(
      fs.existsSync(path.join(t.selected, "bbb.eml")),
      true,
      "the undelivered source is kept",
    );
  });
});
