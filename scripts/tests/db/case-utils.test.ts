import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { getCasePstFileIds } from "../../../src/lib/case-utils";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const requestId = `t-req-${tag}`;
const ids = {
  w1a: `t-w1a-${tag}`,
  w1b: `t-w1b-${tag}`,
  w2a: `t-w2a-${tag}`,
  w2b: `t-w2b-${tag}`,
};

describe("getCasePstFileIds is scoped to request and wave", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-WAVE-${tag}`,
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
        staging_path: `/nonexistent/${tag}/Staging/R1`,
        deliverable_path: `/nonexistent/${tag}/Results/R1`,
        wave: 2,
      },
    });
    for (const [key, wave] of [
      ["w1a", 1],
      ["w1b", 1],
      ["w2a", 2],
      ["w2b", 2],
    ] as const) {
      await prisma.processedFile.create({
        data: {
          id: ids[key],
          filename: `${key}.pst`,
          filepath: `/nonexistent/${tag}/Staging/R1/PST/${key}.pst`,
          kind: "pst",
          case_request_id: requestId,
          wave,
        },
      });
    }
  });

  after(async () => {
    await prisma.processedFile.deleteMany({
      where: { case_request_id: requestId },
    });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("returns only the current wave's PST rows", async () => {
    assert.deepEqual((await getCasePstFileIds(ids.w2a)).sort(), [
      ids.w2a,
      ids.w2b,
    ]);
  });

  it("does not mix earlier waves into a later coordinator", async () => {
    assert.deepEqual((await getCasePstFileIds(ids.w1a)).sort(), [
      ids.w1a,
      ids.w1b,
    ]);
  });
});
