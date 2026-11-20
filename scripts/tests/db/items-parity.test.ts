import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createEmailRecord } from "../../../src/lib/email-decisions";
import { checkEmailCoverage } from "../../../src/lib/items-parity";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-par-case-${tag}`;
const requestId = `t-par-req-${tag}`;
const fileId = `t-par-file-${tag}`;
const hash = (n: number) => `t-par-${tag}-${n}`;

describe("checkEmailCoverage", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-PAR-${tag}`,
        subject_name: "Test Subject",
        subject_email: "t@example.com",
      },
    });
    await prisma.caseRequest.create({
      data: {
        id: requestId,
        case_id: caseId,
        name: "R1",
        scope: "mail",
        status: "completed",
        staging_path: `/tmp/${tag}/s`,
        deliverable_path: `/tmp/${tag}/d`,
      },
    });
    await prisma.processedFile.create({
      data: {
        id: fileId,
        filename: "a.pst",
        filepath: `/tmp/${tag}/a.pst`,
        kind: "pst",
        case_request_id: requestId,
      },
    });
    const base = (n: number) => ({
      id: hash(n),
      file_id: fileId,
      email_hash: hash(n),
      is_duplicate: 0,
    });
    await createEmailRecord({ data: base(1) });
    await createEmailRecord({
      data: base(2),
      decision: {
        decision: "keep",
        rule: "ai_email",
        reason: "k",
        decidedBy: "haiku-4.5",
      },
    });
    // An email row that never reached the trail, and a duplicate (no item of its own).
    await prisma.email.create({ data: base(3) });
    await prisma.email.create({ data: { ...base(4), is_duplicate: 1 } });
  });

  after(async () => {
    await prisma.item.deleteMany({
      where: { id: { startsWith: `t-par-${tag}` } },
    });
    await prisma.email.deleteMany({ where: { file_id: fileId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("finds an email with no item and counts what is waiting", async () => {
    const coverage = await checkEmailCoverage(requestId);
    assert.equal(coverage.emails, 3);
    assert.equal(coverage.missingCount, 1);
    assert.deepEqual(coverage.missingItems, [hash(3)]);
    assert.equal(coverage.items, 2);
    assert.equal(coverage.pending, 1);
    assert.equal(coverage.orphanItems, 0);
  });
});
