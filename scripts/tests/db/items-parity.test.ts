import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { syncEmailItems } from "../../../src/lib/items";
import {
  checkEmailParity,
  problemsByStage,
} from "../../../src/lib/items-parity";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-par-case-${tag}`;
const requestId = `t-par-req-${tag}`;
const fileId = `t-par-file-${tag}`;
const hash = (n: number) => `t-par-${tag}-${n}`;

async function email(
  n: number,
  decision: string | null,
  reason: string | null,
  extra: Record<string, unknown> = {},
) {
  await prisma.email.create({
    data: {
      id: hash(n),
      file_id: fileId,
      email_hash: hash(n),
      ai_decision: decision,
      ai_reason: reason,
      ...extra,
    },
  });
}

describe("checkEmailParity", () => {
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
    await email(1, "keep", "Kept");
    await email(2, "discard", "Pre-filter: Data subject not mentioned");
    await email(3, "discard", "AI said no");
    await email(4, null, null);
    await email(5, "keep", "Decided without a trail");
    await email(6, "discard", "Duplicate row", { is_duplicate: 1 });
    await syncEmailItems([hash(1), hash(2), hash(3)]);
    // Someone changes the decision of email 3 without recording it.
    await prisma.email.update({
      where: { id: hash(3) },
      data: { ai_decision: "keep", ai_reason: "Changed later" },
    });
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

  it("finds a missing item and a decision changed without the trail", async () => {
    const parity = await checkEmailParity(requestId);
    // Emails 1, 2, 3 and 5 count; 4 is undecided with no item and 6 is a duplicate.
    assert.equal(parity.checked, 4);
    assert.equal(parity.matching, 2);
    const byHash = new Map(parity.problems.map((p) => [p.emailHash, p]));
    assert.equal(byHash.get(hash(3))?.kind, "state_differs");
    assert.equal(byHash.get(hash(3))?.expected, "kept");
    assert.equal(byHash.get(hash(3))?.actual, "discarded");
    assert.equal(byHash.get(hash(5))?.kind, "missing_item");
    const groups = problemsByStage(parity.problems);
    assert.equal(
      groups.reduce((sum, g) => sum + g.count, 0),
      2,
    );
  });
});
