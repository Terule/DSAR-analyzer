import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runPhaseJob } from "../../../src/lib/control-plane/phase-runner";
import { getControlPlanePool } from "../../../src/lib/control-plane/postgres";
import { ensureControlPlaneSchema } from "../../../src/lib/control-plane/schema";
import type { ControlJobRecord } from "../../../src/lib/control-plane/types";
import { prisma } from "../../../src/lib/prisma";
import { closeQueueAdapter } from "../../../src/lib/queue/factory";

const tag = crypto.randomUUID().slice(0, 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "extract-retry-"));
process.env.STAGING_PATH = path.join(root, "staging");
process.env.EXTRACTED_PATH = path.join(root, "extracted");
const created: string[] = [];

async function row(extra: Record<string, unknown> = {}) {
  const id = `t-xr-${tag}-${created.length}`;
  created.push(id);
  return prisma.processedFile.create({
    data: {
      id,
      // One folder per row: rows sharing a PST folder are siblings of one case.
      filepath: path.join(
        root,
        "staging",
        `ZZ-${tag}-${created.length}`,
        "R1",
        "PST",
        `${id}.pst`,
      ),
      kind: "pst",
      ...extra,
    },
  });
}

function extractJob(fileId: string): ControlJobRecord {
  return {
    id: crypto.randomUUID(),
    phase: "extract",
    status: "running",
    dedupeKey: `extract:${fileId}`,
    payload: { fileId, caseKey: `ZZ-${tag}`, phase: "extract" },
    priority: 0,
    maxAttempts: 5,
    availableAt: new Date().toISOString(),
    leaseExpiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function jobPhases(fileId: string): Promise<string[]> {
  const result = await getControlPlanePool().query<{ phase: string }>(
    `SELECT phase FROM orchestrator_jobs WHERE payload->>'fileId' = $1`,
    [fileId],
  );
  return result.rows.map((r) => r.phase);
}

describe("extract retry after the worker died post-extraction", () => {
  before(async () => {
    await ensureControlPlaneSchema();
  });
  after(async () => {
    await getControlPlanePool().query(
      `DELETE FROM orchestrator_jobs WHERE payload->>'fileId' = ANY($1)`,
      [created],
    );
    await prisma.processedFile.deleteMany({ where: { id: { in: created } } });
    fs.rmSync(root, { recursive: true, force: true });
    await prisma.$disconnect();
    await closeQueueAdapter();
    await getControlPlanePool().end();
  });

  it("does nothing when the case already moved on to Render", async () => {
    const r = await row({
      status: "completed",
      ai_status: "completed",
      pdf_status: "processing",
    });
    const result = await runPhaseJob(extractJob(r.id));
    assert.equal(result.operation, "extract-already-complete");
    const after = await prisma.processedFile.findUniqueOrThrow({
      where: { id: r.id },
    });
    assert.equal(after.status, "completed");
    assert.equal(after.pdf_status, "processing");
    assert.deepEqual(await jobPhases(r.id), []);
  });

  it("does nothing while mail screening holds the coordinator", async () => {
    const r = await row({
      status: "completed",
      ai_status: "batch_ready",
      mail_screen_status: "screening",
    });
    const result = await runPhaseJob(extractJob(r.id));
    assert.equal(result.operation, "extract-already-complete");
    assert.deepEqual(await jobPhases(r.id), []);
  });

  it("finishes the hand-off, without a new Parse, when nothing downstream started", async () => {
    const r = await row({ status: "completed" });
    const result = await runPhaseJob(extractJob(r.id));
    assert.equal(result.operation, "extract");
    const phases = await jobPhases(r.id);
    assert.ok(phases.includes("ai"), "queues the AI phase");
    assert.ok(!phases.includes("parse"), "never re-parses a finished row");
    const after = await prisma.processedFile.findUniqueOrThrow({
      where: { id: r.id },
    });
    assert.equal(after.status, "completed");
  });

  it("still re-parses a row that never finished extraction", async () => {
    // "failed", not "extracting": the dispatcher's reconcile would otherwise
    // re-enqueue an Extract for this fake row while the test runs.
    const r = await row({ status: "failed" });
    const result = await runPhaseJob(extractJob(r.id));
    assert.equal(result.operation, "parse-recovery-scheduled");
    assert.ok((await jobPhases(r.id)).includes("parse"));
  });
});
