import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { checkEmailCoverage } from "../../../src/lib/items-parity";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-bf-case-${tag}`;
const requestId = `t-bf-req-${tag}`;
const fileId = `t-bf-file-${tag}`;
const hash = (n: number) => `t-bf-${tag}-${n}`;

const MIGRATION = path.join(
  process.cwd(),
  "prisma/migrations/20261120130000_items_backfill_emails/migration.sql",
);

/** Runs the migration's statements one by one (comments dropped). */
async function runMigration() {
  const sql = fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const statement of sql.split(/;\s*\n/).map((s) => s.trim())) {
    if (statement) await prisma.$executeRawUnsafe(statement);
  }
}

const LEGACY: Array<[string | null, string | null, Record<string, number>]> = [
  ["keep", "Kept for the subject", {}],
  [
    "discard",
    "Pre-filter: Subject or body contains privileged/confidential keyword",
    {},
  ],
  ["discard", "Pre-filter: Data subject not mentioned", {}],
  ["discard", "System Discard: Draft (Missing Routing Headers)", {}],
  ["keep", "Client case: deduplication only", {}],
  [
    "warning",
    "Self-forward: Subject sent from company email to personal email",
    {},
  ],
  ["review", "A person decides", {}],
  ["discard", "AI said no", {}],
  [null, null, {}],
  ["discard", "Duplicate row", { is_duplicate: 1 }],
];

describe("items backfill migration", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-BF-${tag}`,
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
    for (const [index, [decision, reason, extra]] of LEGACY.entries()) {
      await prisma.email.create({
        data: {
          id: hash(index),
          file_id: fileId,
          email_hash: hash(index),
          ai_decision: decision,
          ai_reason: reason,
          ...extra,
        },
      });
    }
  });

  after(async () => {
    await prisma.item.deleteMany({
      where: { id: { startsWith: `t-bf-${tag}` } },
    });
    await prisma.email.deleteMany({ where: { file_id: fileId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("gives every decided email an item that agrees with the email, and is safe to run twice", async () => {
    await runMigration();
    const items = await prisma.item.findMany({
      where: { id: { startsWith: `t-bf-${tag}` } },
      include: { events: true },
    });
    // Eight decided emails; the undecided one and the duplicate get none.
    assert.equal(items.length, 8);
    const byRule = new Map(items.map((item) => [item.decision_rule, item]));
    assert.equal(byRule.get("keyword")?.state, "discarded");
    assert.equal(byRule.get("keyword")?.decided_by, "rule");
    assert.equal(byRule.get("self_forward")?.state, "review");
    assert.equal(byRule.get("mail_screen")?.state, "review");
    assert.equal(byRule.get("mail_screen")?.decided_by, "bedrock");
    assert.equal(byRule.get("ai_email")?.decided_by, null);
    assert.ok(items.every((item) => item.case_request_id === requestId));
    assert.ok(items.every((item) => item.events.length === 1));

    const coverage = await checkEmailCoverage(requestId);
    // The one undecided email has no item until the queue migration runs.
    assert.equal(coverage.missingCount, 1);
    assert.equal(coverage.emails, 9);

    await runMigration();
    const again = await prisma.item.count({
      where: { id: { startsWith: `t-bf-${tag}` } },
    });
    const events = await prisma.itemEvent.count({
      where: { item: { id: { startsWith: `t-bf-${tag}` } } },
    });
    assert.equal(again, 8);
    assert.equal(events, 8);
  });
});
