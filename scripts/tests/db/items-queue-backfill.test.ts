import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-qb-case-${tag}`;
const requestId = `t-qb-req-${tag}`;
const fileId = `t-qb-file-${tag}`;
const runId = `t-qb-run-${tag}`;
const hash = (n: string) => `t-qb-${tag}-${n}`;

const MIGRATION = path.join(
  process.cwd(),
  "prisma/migrations/20261120140000_items_ai_queue/migration.sql",
);

/** The data statements of the migration (the DDL already exists in the test database). */
async function runDataStatements() {
  const sql = fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const statement of sql.split(/;\s*\n/).map((s) => s.trim())) {
    if (/^(INSERT|UPDATE)\b/i.test(statement)) {
      await prisma.$executeRawUnsafe(statement);
    }
  }
}

describe("items AI queue migration (data)", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-QB-${tag}`,
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
    await prisma.aiBatchRun.create({
      data: { id: runId, coordinator_id: fileId, status: "submitted" },
    });
    const email = (
      name: string,
      extra: Record<string, unknown> = {},
    ): Promise<unknown> =>
      prisma.email.create({
        data: {
          id: hash(name),
          file_id: fileId,
          email_hash: hash(name),
          ...extra,
        },
      });
    // Waiting for the AI, never given an item.
    await email("waiting");
    // Claimed by a Batch run, still undecided.
    await email("claimed", { ai_batch_run_id: runId });
    // A 4.5 discard waiting for the second review.
    await email("review", {
      ai_decision: "discard",
      ai_reason: "AI said no",
      ai_p_keep: 22,
      rereview_status: "pending",
      rereview_queued_at: new Date("2026-11-19T10:00:00Z"),
      rereview_coordinator_id: fileId,
    });
    // A duplicate has no item of its own.
    await email("dup", { is_duplicate: 1 });
  });

  after(async () => {
    await prisma.item.deleteMany({
      where: { id: { startsWith: `t-qb-${tag}` } },
    });
    await prisma.email.deleteMany({ where: { file_id: fileId } });
    await prisma.aiBatchRun.deleteMany({ where: { id: runId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("gives waiting emails a pending item and moves the queue columns, once", async () => {
    // Earlier migrations first: the decided email needs its decided item.
    const backfill = path.join(
      process.cwd(),
      "prisma/migrations/20261120130000_items_backfill_emails/migration.sql",
    );
    const earlier = fs
      .readFileSync(backfill, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const statement of earlier.split(/;\s*\n/).map((s) => s.trim())) {
      if (statement) await prisma.$executeRawUnsafe(statement);
    }
    await runDataStatements();

    const items = new Map(
      (
        await prisma.item.findMany({
          where: { id: { startsWith: `t-qb-${tag}` } },
        })
      ).map((item) => [item.id, item]),
    );
    assert.equal(items.get(hash("waiting"))?.state, "pending");
    assert.equal(items.get(hash("claimed"))?.state, "pending");
    assert.equal(items.get(hash("claimed"))?.ai_batch_run_id, runId);
    const review = items.get(hash("review"));
    assert.equal(review?.state, "discarded");
    assert.equal(review?.ai_p_keep, 22);
    assert.equal(review?.rereview_status, "pending");
    assert.equal(review?.rereview_coordinator_id, fileId);
    assert.equal(items.has(hash("dup")), false);

    // The pending items can be told apart and claimed, as the AI phase does.
    const waiting = await prisma.item.count({
      where: {
        file_id: fileId,
        kind: "email",
        state: "pending",
        ai_batch_run_id: null,
      },
    });
    assert.equal(waiting, 1);

    // Running it again changes nothing.
    await runDataStatements();
    assert.equal(
      await prisma.item.count({ where: { id: { startsWith: `t-qb-${tag}` } } }),
      3,
    );
    assert.equal(
      await prisma.itemEvent.count({
        where: { item: { id: hash("waiting") } },
      }),
      1,
    );
  });
});
