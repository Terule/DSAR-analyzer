import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  countEmailVerdicts,
  createEmailRecord,
  decideEmail,
  decideEmails,
} from "../../../src/lib/email-decisions";
import { checkEmailParity } from "../../../src/lib/items-parity";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-dec-case-${tag}`;
const requestId = `t-dec-req-${tag}`;
const fileId = `t-dec-file-${tag}`;
const hash = (n: number | string) => `t-dec-${tag}-${n}`;

async function plainEmail(n: number | string) {
  await prisma.email.create({
    data: { id: hash(n), file_id: fileId, email_hash: hash(n) },
  });
}

describe("email decisions (one writer)", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-DEC-${tag}`,
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
        status: "running",
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
  });

  after(async () => {
    await prisma.item.deleteMany({
      where: { id: { startsWith: `t-dec-${tag}` } },
    });
    await prisma.email.deleteMany({ where: { file_id: fileId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("writes the email, the item and its event together", async () => {
    await plainEmail(1);
    const written = await decideEmail({
      emailHash: hash(1),
      decision: "discard",
      rule: "draft",
      reason: "System Discard: Draft (Missing Routing Headers)",
      decidedBy: "rule",
      label: "Re: lunch",
    });
    assert.equal(written, 1);
    const email = await prisma.email.findUnique({
      where: { email_hash: hash(1) },
    });
    assert.equal(email?.ai_decision, "discard");
    const item = await prisma.item.findUnique({ where: { id: hash(1) } });
    assert.equal(item?.state, "discarded");
    assert.equal(item?.decision_rule, "draft");
    assert.equal(item?.decided_by, "rule");
    assert.equal(item?.label, "Re: lunch");
    assert.equal(item?.case_request_id, requestId);
    const events = await prisma.itemEvent.count({
      where: { item_id: hash(1) },
    });
    assert.equal(events, 1);
    // The same decision again changes nothing and adds no event.
    await decideEmail({
      emailHash: hash(1),
      decision: "discard",
      rule: "draft",
      reason: "System Discard: Draft (Missing Routing Headers)",
      decidedBy: "rule",
    });
    assert.equal(
      await prisma.itemEvent.count({ where: { item_id: hash(1) } }),
      1,
    );
  });

  it("skips an email whose guard no longer matches, in both tables", async () => {
    await plainEmail(2);
    const written = await decideEmail({
      emailHash: hash(2),
      decision: "discard",
      rule: "mail_screen",
      reason: "x",
      decidedBy: "bedrock",
      guard: { state: "kept" },
    });
    assert.equal(written, 0);
    const email = await prisma.email.findUnique({
      where: { email_hash: hash(2) },
    });
    assert.equal(email?.ai_decision, null);
    assert.equal(await prisma.item.count({ where: { id: hash(2) } }), 0);
  });

  it("applies extra email columns and records a review verdict", async () => {
    await plainEmail(3);
    await prisma.item.create({
      data: {
        id: hash(3),
        file_id: fileId,
        case_request_id: requestId,
        kind: "email",
        origin: "pst",
        state: "discarded",
        decision_rule: "ai_email",
        rereview_status: "running",
      },
    });
    await decideEmail({
      emailHash: hash(3),
      decision: "keep",
      rule: "ai_email",
      reason: "Rescued",
      decidedBy: "haiku-5.5",
      guard: { rereview_status: "running" },
      itemData: { rereview_status: null },
    });
    const rescued = await prisma.item.findUnique({ where: { id: hash(3) } });
    assert.equal(rescued?.rereview_status, null);
    assert.equal(rescued?.state, "kept");
    const email = await prisma.email.findUnique({
      where: { email_hash: hash(3) },
    });
    assert.equal(email?.ai_decision, "keep");
    await plainEmail(4);
    await decideEmail({
      emailHash: hash(4),
      decision: "review",
      rule: "mail_screen",
      reason: "A person decides",
      decidedBy: "bedrock",
    });
    const item = await prisma.item.findUnique({ where: { id: hash(4) } });
    assert.equal(item?.state, "review");
  });

  it("writes a thousand decisions in chunks", async () => {
    await prisma.email.createMany({
      data: Array.from({ length: 1_200 }, (_, i) => ({
        id: hash(`bulk-${i}`),
        file_id: fileId,
        email_hash: hash(`bulk-${i}`),
      })),
    });
    const written = await decideEmails(
      Array.from({ length: 1_200 }, (_, i) => ({
        emailHash: hash(`bulk-${i}`),
        decision: (i % 2 === 0 ? "keep" : "discard") as "keep" | "discard",
        rule: "ai_email",
        reason: "bulk",
        decidedBy: "haiku-4.5",
      })),
    );
    assert.equal(written, 1_200);
    assert.equal(
      await prisma.item.count({
        where: { id: { startsWith: hash("bulk-") }, state: "kept" },
      }),
      600,
    );
  });

  it("creates an email already decided, or waiting", async () => {
    await createEmailRecord({
      data: {
        id: hash("c1"),
        file_id: fileId,
        email_hash: hash("c1"),
        is_duplicate: 0,
      },
      label: "Subject line",
      decision: {
        decision: "warning",
        rule: "self_forward",
        reason: "Self-forward: x",
        decidedBy: "rule",
      },
    });
    await createEmailRecord({
      data: { id: hash("c2"), file_id: fileId, email_hash: hash("c2") },
      label: "Waiting",
    });
    const forwarded = await prisma.item.findUnique({
      where: { id: hash("c1") },
    });
    assert.equal(forwarded?.state, "review");
    assert.equal(
      (await prisma.email.findUnique({ where: { email_hash: hash("c1") } }))
        ?.ai_decision,
      "warning",
    );
    const waiting = await prisma.item.findUnique({ where: { id: hash("c2") } });
    assert.equal(waiting?.state, "pending");
  });

  it("does not leave the email decided when the audit trail cannot be written", async () => {
    await plainEmail("atomic");
    // An item with this id but a missing required value makes the item write fail.
    await assert.rejects(() =>
      decideEmail({
        emailHash: hash("atomic"),
        decision: "keep",
        rule: "ai_email",
        // @ts-expect-error: forcing the audit write to fail
        reason: { not: "a string" },
        decidedBy: "haiku-4.5",
      }),
    );
    const email = await prisma.email.findUnique({
      where: { email_hash: hash("atomic") },
    });
    assert.equal(email?.ai_decision, null);
  });

  it("counts kept and discarded emails from the audit trail, not the duplicates", async () => {
    const before = await countEmailVerdicts([fileId]);
    await plainEmail("count-a");
    await plainEmail("count-b");
    await decideEmail({
      emailHash: hash("count-a"),
      decision: "keep",
      rule: "ai_email",
      reason: "k",
      decidedBy: "haiku-4.5",
    });
    await decideEmail({
      emailHash: hash("count-b"),
      decision: "discard",
      rule: "ai_email",
      reason: "d",
      decidedBy: "haiku-4.5",
    });
    // A duplicate item and a self-forward are not counted as either.
    await prisma.item.create({
      data: {
        id: hash("count-dup"),
        file_id: fileId,
        case_request_id: requestId,
        kind: "email",
        origin: "pst",
        state: "discarded",
        decision_rule: "dup",
      },
    });
    const after = await countEmailVerdicts([fileId]);
    assert.equal(after.kept, before.kept + 1);
    assert.equal(after.discarded, before.discarded + 1);
  });

  it("leaves emails and items in agreement", async () => {
    const parity = await checkEmailParity(requestId);
    assert.equal(parity.problems.length, 0);
    assert.ok(parity.checked >= 1_200);
  });
});
