import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { emailAiTestOverride, generateBatchFile } from "../../../src/lib/ai";
import { pollBatchStatus } from "../../../src/lib/batch-worker";
import { createEmailRecord } from "../../../src/lib/email-decisions";
import type { FilesAiClient } from "../../../src/lib/files-ai";
import { prisma } from "../../../src/lib/prisma";
import { getPstWorkFolder } from "../../../src/lib/pst-artifacts";

const tag = crypto.randomUUID().slice(0, 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "email-bedrock-"));
const staging = path.join(root, "staging");
const extracted = path.join(root, "extracted");
process.env.STAGING_PATH = staging;
process.env.EXTRACTED_PATH = extracted;

const criteria = {
  name: "Maria Santos",
  email: "maria@corp.com",
  aliases: [] as string[],
};

/** Looks like a Bedrock client: ids carry the prefix, output comes back in the batch-output shape. */
class FakeBedrock implements FilesAiClient {
  uploaded: string[] = [];
  outputs = new Map<string, string>();
  statuses = new Map<
    string,
    { status: string; outputFileId?: string | null }
  >();
  async uploadBatchFile(filePath: string) {
    this.uploaded = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).custom_id);
    return "input";
  }
  async createBatch() {
    return `bedrock-batch:/tmp/${tag}-state.bedrock.json`;
  }
  async retrieveBatch(id: string) {
    return this.statuses.get(id) ?? { status: "in_progress" };
  }
  async readFile(id: string) {
    return this.outputs.get(id) ?? "";
  }
}

const line = (customId: string, answer: object) =>
  JSON.stringify({
    custom_id: customId,
    response: {
      body: { choices: [{ message: { content: JSON.stringify(answer) } }] },
    },
  });

describe("employee email audit on Bedrock", () => {
  const caseId = `t-eb-case-${tag}`;
  const fileId = `t-eb-file-${tag}`;
  const siblingId = `t-eb-sib-${tag}`;
  const requestId = `t-eb-req-${tag}`;

  after(async () => {
    emailAiTestOverride.client = undefined;
    emailAiTestOverride.converse = undefined;
    await prisma.email.deleteMany({
      where: { email_hash: { startsWith: `${tag}-` } },
    });
    await prisma.aiBatchRun.deleteMany({ where: { coordinator_id: fileId } });
    await prisma.processedFile.deleteMany({
      where: { id: { in: [fileId, siblingId] } },
    });
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    fs.rmSync(root, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("submits through the client, reads the result, runs the second pass on Converse and settles", async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-${caseId}`,
        subject_name: criteria.name,
        subject_email: criteria.email,
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
    const filepath = path.join(staging, `ZZ-${caseId}`, "R1", "PST", "a.pst");
    await prisma.processedFile.create({
      data: {
        id: fileId,
        filename: "a.pst",
        kind: "pst",
        filepath,
        case_request_id: requestId,
        ai_status: "processing",
      },
    });
    // A sibling PST that is not done keeps the case from rendering in this test.
    await prisma.processedFile.create({
      data: {
        id: siblingId,
        filename: "b.pst",
        kind: "pst",
        filepath: path.join(staging, `ZZ-${caseId}`, "R1", "PST", "b.pst"),
        case_request_id: requestId,
        ai_status: "batch_ready",
      },
    });
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

    const hash = (n: string) => `${tag}-${n}`;
    const payloads: Record<string, object> = {
      fromSubject: {
        first_email: {
          from: "maria@corp.com",
          to: "tom@corp.com",
          subject: "Leeds timeline",
          body: "Tom, attached is the timeline.",
        },
        meta: { attachment_count: 0, to_recipient_count: 1 },
        attachments: [],
      },
      notAboutSubject: {
        first_email: {
          from: "tom@corp.com",
          to: "ana@corp.com",
          subject: "Lunch",
          body: "Lunch on Friday?",
        },
        meta: { attachment_count: 0, to_recipient_count: 1 },
        attachments: [],
      },
      attachmentRescue: {
        first_email: {
          from: "tom@corp.com",
          to: "ana@corp.com, paul@corp.com",
          subject: "Files",
          body: "Maria Santos asked about these. See the attached.",
        },
        meta: { attachment_count: 1, to_recipient_count: 2 },
        attachments: [
          {
            filename: "review.pdf",
            content_type: "application/pdf",
            size_bytes: 10,
          },
        ],
      },
    };
    for (const [name, payload] of Object.entries(payloads)) {
      fs.writeFileSync(
        path.join(dirs.json, `${hash(name)}.json`),
        JSON.stringify(payload),
      );
      fs.writeFileSync(path.join(dirs.raw, `${hash(name)}.eml`), "eml");
      await createEmailRecord({
        data: {
          id: crypto.randomUUID(),
          file_id: fileId,
          email_hash: hash(name),
          is_duplicate: 0,
        },
        decision:
          name === "notAboutSubject"
            ? {
                decision: "discard",
                rule: "subject_absent",
                reason: "Pre-filter: Data subject not mentioned",
                decidedBy: "rule",
              }
            : undefined,
      });
    }

    const client = new FakeBedrock();
    emailAiTestOverride.client = client;
    const converseCalls: string[] = [];
    emailAiTestOverride.converse = async (request, modelId) => {
      converseCalls.push(modelId);
      assert.equal(request.toolName, "second_pass_decision");
      return { decision: "keep", reason: "attachment may hold subject data" };
    };

    const submitted = await generateBatchFile(fileId, criteria, {});
    assert.equal(submitted, "submitted");
    // The email Extract already discarded for not citing the subject is not sent.
    assert.deepEqual(
      client.uploaded.sort(),
      [hash("attachmentRescue"), hash("fromSubject")].sort(),
    );
    const run = await prisma.aiBatchRun.findFirstOrThrow({
      where: { coordinator_id: fileId },
    });
    assert.equal(run.status, "submitted");
    assert.match(String(run.openai_batch_id), /^bedrock-batch:/);
    assert.equal(
      (
        await prisma.email.findUniqueOrThrow({
          where: { email_hash: hash("notAboutSubject") },
        })
      ).ai_decision,
      "discard",
    );

    const batchId = String(run.openai_batch_id);
    client.statuses.set(batchId, {
      status: "completed",
      outputFileId: batchId,
    });
    client.outputs.set(
      batchId,
      [
        line(hash("fromSubject"), {
          decision: "keep",
          reason: "sent by the subject",
          needs_second_pass: false,
          sensitivity: "none",
          confidence: 95,
        }),
        line(hash("attachmentRescue"), {
          decision: "discard",
          reason: "weak signal",
          needs_second_pass: true,
          sensitivity: "none",
          confidence: 20,
        }),
      ].join("\n"),
    );

    await pollBatchStatus(fileId);

    const decision = async (name: string) =>
      prisma.email.findUniqueOrThrow({ where: { email_hash: hash(name) } });
    assert.equal((await decision("fromSubject")).ai_decision, "keep");
    assert.equal((await decision("notAboutSubject")).ai_decision, "discard");
    const rescued = await decision("attachmentRescue");
    assert.equal(rescued.ai_decision, "keep");
    assert.match(rescued.ai_reason ?? "", /^Second Pass:/);
    assert.deepEqual(converseCalls, ["eu.anthropic.claude-haiku-5-5"]);
    assert.ok(
      fs.existsSync(path.join(dirs.selected, `${hash("fromSubject")}.eml`)),
    );
    assert.equal(
      (await prisma.aiBatchRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
      "completed",
    );
  });
});
