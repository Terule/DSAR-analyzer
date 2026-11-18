import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { emailAiTestOverride, generateBatchFile } from "../../../src/lib/ai";
import { pollBatchStatus } from "../../../src/lib/batch-worker";
import { inControlSample } from "../../../src/lib/bedrock/rereview-gate";
import { rereviewEmailDiscards } from "../../../src/lib/email-rereview";
import type { FilesAiClient } from "../../../src/lib/files-ai";
import { prisma } from "../../../src/lib/prisma";
import { getPstWorkFolder } from "../../../src/lib/pst-artifacts";

const tag = crypto.randomUUID().slice(0, 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "email-rereview-"));
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

/** A hash that stays out of the 2% control sample, so the test does not depend on luck. */
const outsideSample = (name: string) => {
  for (let i = 0; ; i++) {
    const hash = `${tag}-${name}${i}`;
    if (!inControlSample(hash, 0.02)) return hash;
  }
};

describe("second review of Haiku 4.5 email discards", () => {
  const caseId = `t-er-case-${tag}`;
  const fileId = `t-er-file-${tag}`;
  const siblingId = `t-er-sib-${tag}`;
  const requestId = `t-er-req-${tag}`;

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

  it("queues doubtful discards, holds the phase, then settles them on Haiku 5.5", async () => {
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
        subject_name: criteria.name,
        subject_email: criteria.email,
        ai_status: "processing",
      },
    });
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

    const names = {
      kept: `${tag}-kept`,
      sure: outsideSample("sure"),
      rescued: outsideSample("rescued"),
      confirmed: outsideSample("confirmed"),
      failed: outsideSample("failed"),
    };
    for (const hash of Object.values(names)) {
      fs.writeFileSync(
        path.join(dirs.json, `${hash}.json`),
        JSON.stringify({
          first_email: {
            from: "tom@corp.com",
            to: "ana@corp.com",
            subject: "Planning",
            body: "Maria Santos will be away on Friday.",
          },
          meta: { attachment_count: 0, to_recipient_count: 1 },
          attachments: [],
        }),
      );
      fs.writeFileSync(path.join(dirs.raw, `${hash}.eml`), "eml");
      await prisma.email.create({
        data: {
          id: crypto.randomUUID(),
          file_id: fileId,
          email_hash: hash,
          is_duplicate: 0,
        },
      });
    }

    const client = new FakeBedrock();
    emailAiTestOverride.client = client;
    assert.equal(await generateBatchFile(fileId, criteria, {}), "submitted");
    const run = await prisma.aiBatchRun.findFirstOrThrow({
      where: { coordinator_id: fileId },
    });
    const batchId = String(run.openai_batch_id);
    client.statuses.set(batchId, {
      status: "completed",
      outputFileId: batchId,
    });
    const discard = (hash: string, confidence: number) =>
      line(hash, {
        decision: "discard",
        reason: "not about the subject",
        needs_second_pass: false,
        sensitivity: "none",
        confidence,
      });
    client.outputs.set(
      batchId,
      [
        line(names.kept, {
          decision: "keep",
          reason: "about the subject",
          needs_second_pass: false,
          sensitivity: "none",
          confidence: 90,
        }),
        discard(names.sure, 0),
        discard(names.rescued, 30),
        discard(names.confirmed, 40),
        discard(names.failed, 25),
      ].join("\n"),
    );

    await pollBatchStatus(fileId);

    const row = (hash: string) =>
      prisma.email.findUniqueOrThrow({ where: { email_hash: hash } });
    // Only the discards with doubt wait; the sure one is final.
    assert.equal((await row(names.sure)).rereview_status, null);
    for (const hash of [names.rescued, names.confirmed, names.failed]) {
      const waiting = await row(hash);
      assert.equal(waiting.ai_decision, "discard");
      assert.equal(waiting.rereview_status, "pending");
      assert.equal(waiting.rereview_coordinator_id, fileId);
    }
    // The phase is held: Render reads selected/, which the review may change.
    assert.equal(
      (await prisma.processedFile.findUniqueOrThrow({ where: { id: fileId } }))
        .ai_status,
      "processing",
    );

    const calls: string[] = [];
    const settled = await rereviewEmailDiscards({
      coordinatorId: fileId,
      converse: async (request, modelId) => {
        calls.push(`${request.toolName}:${modelId}`);
        if (request.customId === names.failed) throw new Error("boom");
        return request.customId === names.rescued
          ? {
              decision: "keep",
              reason: "about the subject's leave",
              needs_second_pass: false,
              sensitivity: "none",
            }
          : {
              decision: "discard",
              reason: "a task, not about the subject",
              needs_second_pass: false,
              sensitivity: "none",
            };
      },
    });
    assert.equal(settled, 3);
    assert.equal(calls.length, 3);
    assert.ok(
      calls.every(
        (c) => c === "dsar_audit_decision:eu.anthropic.claude-haiku-5-5",
      ),
    );

    const rescued = await row(names.rescued);
    assert.equal(rescued.ai_decision, "keep");
    assert.match(rescued.ai_reason ?? "", /^Kept on second review/);
    assert.equal(rescued.rereview_status, null);
    assert.ok(fs.existsSync(path.join(dirs.selected, `${names.rescued}.eml`)));
    assert.ok(
      !fs.existsSync(path.join(dirs.discarded, `${names.rescued}.eml`)),
    );

    const confirmed = await row(names.confirmed);
    assert.equal(confirmed.ai_decision, "discard");
    assert.match(confirmed.ai_reason ?? "", /^Confirmed on second review/);
    assert.ok(
      fs.existsSync(path.join(dirs.discarded, `${names.confirmed}.eml`)),
    );

    // A failed review keeps the email: the audit errs toward keeping.
    const failed = await row(names.failed);
    assert.equal(failed.ai_decision, "keep");
    assert.match(failed.ai_reason ?? "", /failed/);
    assert.ok(fs.existsSync(path.join(dirs.selected, `${names.failed}.eml`)));

    // Counters were recomputed and the phase moved on past the audit.
    const coordinator = await prisma.processedFile.findUniqueOrThrow({
      where: { id: fileId },
    });
    assert.equal(coordinator.ai_approved_count, 3);
    assert.equal(coordinator.ai_discarded_count, 2);
    assert.notEqual(coordinator.ai_status, "processing");
  });
});
