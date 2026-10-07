import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { failRowIfJobExhausted } from "../../../src/lib/control-plane/exhausted";
import { getControlPlanePool } from "../../../src/lib/control-plane/postgres";
import { ensureControlPlaneSchema } from "../../../src/lib/control-plane/schema";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const created: string[] = [];

async function row(extra: Record<string, unknown> = {}) {
  const id = `t-ex-${tag}-${created.length}`;
  created.push(id);
  return prisma.processedFile.create({
    data: {
      id,
      filepath: `/data/Staging/ZZ-${tag}/R1/PST/${id}.pst`,
      kind: "pst",
      ...extra,
    },
  });
}

async function job(
  fileId: string,
  phase: string,
  status: string,
  ageSeconds: number,
  lastError: string | null = null,
) {
  await getControlPlanePool().query(
    `INSERT INTO orchestrator_jobs
       (id, phase, status, dedupe_key, payload, attempts, max_attempts, last_error, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 5, 5, $6, NOW() - ($7 || ' seconds')::interval, NOW() - ($7 || ' seconds')::interval)`,
    [
      crypto.randomUUID(),
      phase,
      status,
      `${phase}:${fileId}:${crypto.randomUUID()}`,
      JSON.stringify({ fileId, phase }),
      lastError,
      String(ageSeconds),
    ],
  );
}

describe("failRowIfJobExhausted", () => {
  before(async () => {
    await ensureControlPlaneSchema();
  });
  after(async () => {
    await getControlPlanePool().query(
      `DELETE FROM orchestrator_jobs WHERE payload->>'fileId' = ANY($1)`,
      [created],
    );
    await prisma.processedFile.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
    await getControlPlanePool().end();
  });

  it("marks a render row failed when its latest job dead-lettered", async () => {
    const r = await row({ pdf_status: "processing" });
    await job(r.id, "render", "dead_letter", 10, "Worker exited 133");
    assert.equal(await failRowIfJobExhausted(r.id, "render"), true);
    const after = await prisma.processedFile.findUniqueOrThrow({
      where: { id: r.id },
    });
    assert.equal(after.pdf_status, "failed");
  });

  it("leaves the row alone when a newer job is queued (a Retry)", async () => {
    const r = await row({ pdf_status: "processing" });
    await job(r.id, "render", "dead_letter", 600);
    await job(r.id, "render", "queued", 5);
    assert.equal(await failRowIfJobExhausted(r.id, "render"), false);
    const after = await prisma.processedFile.findUniqueOrThrow({
      where: { id: r.id },
    });
    assert.equal(after.pdf_status, "processing");
  });

  it("leaves the row alone when there is no job at all", async () => {
    const r = await row({ pdf_status: "processing" });
    assert.equal(await failRowIfJobExhausted(r.id, "render"), false);
  });

  it("marks parse and extract rows failed", async () => {
    const parse = await row({ status: "scanning_metadata" });
    await job(parse.id, "parse", "dead_letter", 10);
    assert.equal(await failRowIfJobExhausted(parse.id, "parse"), true);
    assert.equal(
      (
        await prisma.processedFile.findUniqueOrThrow({
          where: { id: parse.id },
        })
      ).status,
      "failed",
    );
    const extract = await row({ status: "extracting" });
    await job(extract.id, "extract", "dead_letter", 10);
    assert.equal(await failRowIfJobExhausted(extract.id, "extract"), true);
    assert.equal(
      (
        await prisma.processedFile.findUniqueOrThrow({
          where: { id: extract.id },
        })
      ).status,
      "failed",
    );
  });

  it("marks a Files row failed when its latest job dead-lettered", async () => {
    const r = await row({ kind: "files", files_status: "processing" });
    await job(r.id, "files", "dead_letter", 10, "unzip failed");
    assert.equal(await failRowIfJobExhausted(r.id, "files"), true);
    const after = await prisma.processedFile.findUniqueOrThrow({
      where: { id: r.id },
    });
    assert.equal(after.files_status, "failed");
  });

  it("only looks at the requested phase", async () => {
    const r = await row({ pdf_status: "processing" });
    await job(r.id, "parse", "dead_letter", 10);
    assert.equal(await failRowIfJobExhausted(r.id, "render"), false);
  });
});
