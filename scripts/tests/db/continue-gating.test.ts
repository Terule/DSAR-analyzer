import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { continueRequest } from "../../../src/lib/cases";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const requestId = `t-req-${tag}`;
const fileId = `t-file-${tag}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "continue-gate-"));

describe("continue gating on failed rows", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-GATE-${tag}`,
        subject_name: "T",
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
        staging_path: path.join(root, "Staging", "R1"),
        deliverable_path: path.join(root, "Results", "R1"),
      },
    });
    await prisma.processedFile.create({
      data: {
        id: fileId,
        filename: "a.pst",
        filepath: path.join(root, "Staging", "R1", "PST", "a.pst"),
        case_request_id: requestId,
        wave: 1,
        status: "completed",
        ai_status: "completed",
        pdf_status: "failed",
      },
    });
  });

  after(async () => {
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses Continue while the current wave has a failed row", async () => {
    await assert.rejects(
      () => continueRequest(requestId, "mail"),
      /Wave 1 has failed items/,
    );
    const request = await prisma.caseRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    assert.equal(request.wave, 1);
    assert.equal(request.status, "completed");
  });

  it("allows Continue once the row is fixed", async () => {
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { pdf_status: "completed" },
    });
    const next = await continueRequest(requestId, "mail");
    assert.equal(next.wave, 2);
  });
});
