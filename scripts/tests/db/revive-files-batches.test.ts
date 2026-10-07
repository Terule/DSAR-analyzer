import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { reviveFailedFilesBatches } from "../../../src/lib/control-plane/job-store";
import { getControlPlanePool } from "../../../src/lib/control-plane/postgres";
import { ensureControlPlaneSchema } from "../../../src/lib/control-plane/schema";

const tag = crypto.randomUUID().slice(0, 8);
const fileId = `t-rv-file-${tag}`;
const otherFile = `t-rv-other-${tag}`;
const ids: string[] = [];

async function job(opts: {
  fileId?: string;
  runKey?: string;
  status: string;
  metadata?: Record<string, unknown>;
  attempts?: number;
  lastError?: string;
}) {
  const id = crypto.randomUUID();
  ids.push(id);
  const metadata = {
    filesBatch: true,
    runKey: opts.runKey ?? "run-1",
    index: 1,
    paths: ["/data/a.xlsx", "/data/b.docx"],
    largeOfficeBatch: false,
    ...opts.metadata,
  };
  await getControlPlanePool().query(
    `INSERT INTO orchestrator_jobs
       (id, phase, status, dedupe_key, payload, attempts, max_attempts, last_error)
     VALUES ($1, 'files', $2, $3, $4::jsonb, $5, 5, $6)`,
    [
      id,
      opts.status,
      `files-${id}`,
      JSON.stringify({
        fileId: opts.fileId ?? fileId,
        phase: "files",
        metadata,
      }),
      opts.attempts ?? 5,
      opts.lastError ??
        "Worker container disappeared before reporting a result.",
    ],
  );
  return id;
}

async function read(id: string) {
  const result = await getControlPlanePool().query(
    `SELECT status, attempts, last_error, payload FROM orchestrator_jobs WHERE id = $1`,
    [id],
  );
  return result.rows[0] as {
    status: string;
    attempts: number;
    last_error: string;
    payload: { metadata: Record<string, unknown> };
  };
}

describe("reviveFailedFilesBatches", () => {
  before(async () => {
    await ensureControlPlaneSchema();
  });
  after(async () => {
    await getControlPlanePool().query(
      `DELETE FROM orchestrator_jobs WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    await getControlPlanePool().end();
  });

  it("moves a dead-lettered batch into the large lane for one more try", async () => {
    const id = await job({ status: "dead_letter" });
    assert.equal(await reviveFailedFilesBatches(fileId, "run-1"), 1);
    const after = await read(id);
    assert.equal(after.status, "queued");
    assert.equal(after.attempts, 0);
    assert.equal(after.payload.metadata.largeOfficeBatch, true);
    assert.equal(after.payload.metadata.highMemoryRetried, true);
    assert.deepEqual(after.payload.metadata.paths, [
      "/data/a.xlsx",
      "/data/b.docx",
    ]);
    assert.match(after.last_error, /high-memory lane/);
    assert.match(after.last_error, /Worker container disappeared/);
  });

  it("gives a batch only one extra try", async () => {
    const id = await job({
      status: "dead_letter",
      runKey: "run-once",
      metadata: { highMemoryRetried: true, largeOfficeBatch: true },
    });
    assert.equal(await reviveFailedFilesBatches(fileId, "run-once"), 0);
    assert.equal((await read(id)).status, "dead_letter");
  });

  it("leaves everything else alone", async () => {
    const runKey = "run-mixed";
    const completed = await job({ status: "completed", runKey });
    const queued = await job({ status: "queued", runKey, attempts: 0 });
    const running = await job({ status: "running", runKey, attempts: 1 });
    const cancelled = await job({ status: "cancelled", runKey });
    const fallback = await job({
      status: "dead_letter",
      runKey,
      metadata: { filesFallback: true, filesBatch: false },
    });
    const otherRun = await job({ status: "dead_letter", runKey: "run-other" });
    const otherFileJob = await job({
      status: "dead_letter",
      runKey,
      fileId: otherFile,
    });
    assert.equal(await reviveFailedFilesBatches(fileId, runKey), 0);
    assert.equal((await read(completed)).status, "completed");
    assert.equal((await read(queued)).status, "queued");
    assert.equal((await read(running)).status, "running");
    assert.equal((await read(cancelled)).status, "cancelled");
    assert.equal((await read(fallback)).status, "dead_letter");
    assert.equal((await read(otherRun)).status, "dead_letter");
    assert.equal((await read(otherFileJob)).status, "dead_letter");
  });

  it("does not retry a batch that already failed in the large lane", async () => {
    // A giant spreadsheet that kills a 6GB worker would otherwise be retried
    // in the same lane: ten container kills per file instead of five.
    const id = await job({
      status: "dead_letter",
      runKey: "run-large",
      metadata: { largeOfficeBatch: true },
    });
    assert.equal(await reviveFailedFilesBatches(fileId, "run-large"), 0);
    assert.equal((await read(id)).status, "dead_letter");
  });

  it("revives every dead-lettered batch of the run in one call", async () => {
    const runKey = "run-many";
    const a = await job({ status: "dead_letter", runKey });
    const b = await job({ status: "dead_letter", runKey });
    const c = await job({ status: "completed", runKey });
    assert.equal(await reviveFailedFilesBatches(fileId, runKey), 2);
    assert.equal((await read(a)).status, "queued");
    assert.equal((await read(b)).status, "queued");
    assert.equal((await read(c)).status, "completed");
  });
});
