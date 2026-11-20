import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";
import { wipeCaseData } from "../../../src/lib/request-reset";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-wipe-case-${tag}`;
const caseName = `ZZ-WIPE-${tag}`;
const requestIds = [`t-wipe-r1-${tag}`, `t-wipe-r2-${tag}`];

async function request(index: number, status: string) {
  const id = requestIds[index];
  await prisma.caseRequest.create({
    data: {
      id,
      case_id: caseId,
      name: `R${index + 1}`,
      scope: "mail",
      status,
      completed_at: status === "completed" ? new Date() : null,
      deliverable_files: 12,
      staging_path: `/tmp/${id}/s`,
      deliverable_path: `/tmp/${id}/d`,
    },
  });
  await prisma.item.create({
    data: {
      id: `t-wipe-item-${tag}-${index}`,
      case_request_id: id,
      kind: "email",
      origin: "pst",
      label: "Subject",
      state: "kept",
    },
  });
}

describe("wipeCaseData", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: caseName,
        subject_name: "T T",
        subject_email: "t@example.com",
      },
    });
  });
  after(async () => {
    await prisma.item.deleteMany({
      where: { case_request_id: { in: requestIds } },
    });
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
  });

  it("needs the case name typed exactly", async () => {
    await request(0, "completed");
    await assert.rejects(wipeCaseData(caseId, "wrong"), /case name/);
  });

  it("refuses while a request is working", async () => {
    await request(1, "running");
    await assert.rejects(wipeCaseData(caseId, caseName), /Stop all work/);
  });

  it("resets every request and removes the audit trail, keeping the case", async () => {
    await prisma.caseRequest.update({
      where: { id: requestIds[1] },
      data: { status: "completed" },
    });
    assert.equal(await wipeCaseData(caseId, caseName), 2);
    const rows = await prisma.caseRequest.findMany({
      where: { case_id: caseId },
      orderBy: { name: "asc" },
    });
    assert.deepEqual(
      rows.map((row) => [row.status, row.deliverable_files]),
      [
        ["ready", 0],
        ["ready", 0],
      ],
    );
    assert.equal(
      await prisma.item.count({
        where: { case_request_id: { in: requestIds } },
      }),
      0,
    );
    assert.ok(await prisma.managedCase.findUnique({ where: { id: caseId } }));
  });
});
