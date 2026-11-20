import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const fileId = `t-rm-file-${tag}`;
const legacyId = `t-rm-run-${tag}`;
const MIGRATION = path.join(
  process.cwd(),
  "prisma/migrations/20261120150000_ai_runs_one_table/migration.sql",
);

/** The data statement of the migration (the DDL already exists in the test database). */
async function copyLegacyRuns() {
  const sql = fs
    .readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const statement of sql.split(/;\s*\n/).map((s) => s.trim())) {
    if (/^INSERT\b/i.test(statement)) await prisma.$executeRawUnsafe(statement);
  }
}

describe("AI runs in one table (migration data)", () => {
  before(async () => {
    await prisma.processedFile.create({
      data: {
        id: fileId,
        filename: "a.pst",
        filepath: `/tmp/${tag}/a.pst`,
        kind: "pst",
      },
    });
    // A run as the old Files AI table held it.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "files_ai_batch_runs" ("id","file_id","status","request_count","estimated_tokens","attempt") VALUES ('${legacyId}','${fileId}','completed',12,3400,2)`,
    );
  });

  after(async () => {
    await prisma.aiBatchRun.deleteMany({ where: { id: legacyId } });
    await prisma.$executeRawUnsafe(
      `DELETE FROM "files_ai_batch_runs" WHERE "id"='${legacyId}'`,
    );
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.$disconnect();
  });

  it("copies Files runs as kind files, once, and keeps email runs apart", async () => {
    await prisma.aiBatchRun.create({
      data: {
        id: `t-rm-email-${tag}`,
        coordinator_id: fileId,
        status: "submitted",
      },
    });
    await copyLegacyRuns();
    await copyLegacyRuns();
    const copied = await prisma.aiBatchRun.findMany({
      where: { coordinator_id: fileId },
      orderBy: { id: "asc" },
    });
    assert.equal(copied.length, 2);
    const files = copied.find((run) => run.id === legacyId);
    assert.equal(files?.kind, "files");
    assert.equal(files?.attempt, 2);
    assert.equal(files?.request_count, 12);
    assert.equal(files?.estimated_tokens, 3400);
    assert.equal(copied.find((run) => run.id !== legacyId)?.kind, "email");
    // The two kinds are told apart by the filter every reader uses.
    assert.equal(
      await prisma.aiBatchRun.count({
        where: { coordinator_id: fileId, kind: "email" },
      }),
      1,
    );
    await prisma.aiBatchRun.deleteMany({ where: { id: `t-rm-email-${tag}` } });
  });
});
