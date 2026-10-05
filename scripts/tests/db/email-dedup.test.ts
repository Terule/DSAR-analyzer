import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  computeEmailHash,
  isDuplicateEmail,
} from "../../../src/lib/email-dedup";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const requestId = `t-req-${tag}`;
const otherRequestId = `t-req2-${tag}`;
const fileId = `t-file-${tag}`;
const messageId = `msg-${tag}@example.com`;
const base = crypto.createHash("sha256").update(messageId).digest("hex");
const storedHash = computeEmailHash("C/R/PST", base);

describe("isDuplicateEmail", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-DEDUP-${tag}`,
        subject_name: "T",
        subject_email: "t@example.com",
      },
    });
    for (const id of [requestId, otherRequestId]) {
      await prisma.caseRequest.create({
        data: {
          id,
          case_id: caseId,
          name: id,
          scope: "mail",
          staging_path: `/tmp/${id}/s`,
          deliverable_path: `/tmp/${id}/d`,
        },
      });
    }
    await prisma.processedFile.create({
      data: {
        id: fileId,
        filename: "wave1.pst",
        filepath: `/tmp/${tag}/wave1.pst`,
        case_request_id: requestId,
        wave: 1,
      },
    });
    await prisma.email.create({
      data: {
        id: `t-email-${tag}`,
        file_id: fileId,
        message_id: messageId,
        email_hash: storedHash,
      },
    });
  });

  after(async () => {
    await prisma.email.deleteMany({ where: { file_id: fileId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("matches the same hash", async () => {
    assert.equal(
      await isDuplicateEmail({
        emailHash: storedHash,
        messageId,
        caseRequestId: requestId,
      }),
      true,
    );
  });

  it("matches a legacy row by message id within the same request", async () => {
    assert.equal(
      await isDuplicateEmail({
        emailHash: `other-${tag}`,
        messageId,
        caseRequestId: requestId,
      }),
      true,
    );
  });

  it("does not match the message id in another request or without one", async () => {
    assert.equal(
      await isDuplicateEmail({
        emailHash: `other-${tag}`,
        messageId,
        caseRequestId: otherRequestId,
      }),
      false,
    );
    assert.equal(
      await isDuplicateEmail({
        emailHash: `other-${tag}`,
        messageId,
        caseRequestId: null,
      }),
      false,
    );
  });

  it("ignores message ids of 5 characters or fewer", async () => {
    const shortId = "ab@cd";
    await prisma.email.create({
      data: {
        id: `t-email-short-${tag}`,
        file_id: fileId,
        message_id: shortId,
        email_hash: `short-${tag}`,
      },
    });
    assert.equal(
      await isDuplicateEmail({
        emailHash: `other-${tag}`,
        messageId: shortId,
        caseRequestId: requestId,
      }),
      false,
    );
  });
});
