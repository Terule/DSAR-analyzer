import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";
import { pruneWaveSourcePsts } from "../../../src/lib/source-prune";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-db-"));
let counter = 0;

const finished = {
  status: "completed",
  ai_status: "completed",
  pdf_status: "completed",
};

async function setup(options: { wave?: number; renderBase?: number } = {}) {
  counter++;
  const requestId = `t-req-${tag}-${counter}`;
  const staging = path.join(root, `S${counter}`);
  const deliverable = path.join(root, `D${counter}`);
  fs.mkdirSync(path.join(staging, "PST"), { recursive: true });
  fs.mkdirSync(path.join(staging, "Files"), { recursive: true });
  fs.mkdirSync(path.join(deliverable, "Emails"), { recursive: true });
  await prisma.caseRequest.create({
    data: {
      id: requestId,
      case_id: caseId,
      name: `R${counter}`,
      scope: "mail",
      staging_path: staging,
      deliverable_path: deliverable,
      wave: options.wave ?? 1,
      render_base: options.renderBase ?? null,
    },
  });
  const pst = (name: string) => {
    const file = path.join(staging, "PST", name);
    fs.writeFileSync(file, "pst");
    return file;
  };
  const row = (id: string, filepath: string, extra = {}) =>
    prisma.processedFile.create({
      data: {
        id: `t-${tag}-${counter}-${id}`,
        filepath,
        kind: "pst",
        case_request_id: requestId,
        wave: options.wave ?? 1,
        ...finished,
        ...extra,
      },
    });
  const pdf = (name: string) =>
    fs.writeFileSync(path.join(deliverable, "Emails", name), "pdf");
  // A kept email the AI selected for this request's PST rows.
  const kept = (fileId: string, label: string) =>
    prisma.email.create({
      data: {
        id: `t-em-${tag}-${counter}-${label}`,
        file_id: fileId,
        email_hash: `hash-${tag}-${counter}-${label}`,
        ai_decision: "keep",
      },
    });
  return { requestId, staging, deliverable, pst, row, pdf, kept };
}

describe("pruneWaveSourcePsts", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-PRUNE-${tag}`,
        subject_name: "T",
        subject_email: "t@example.com",
      },
    });
  });
  after(async () => {
    await prisma.email.deleteMany({
      where: { processed_file: { case_request: { case_id: caseId } } },
    });
    await prisma.processedFile.deleteMany({
      where: { case_request: { case_id: caseId } },
    });
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.pipelineSettings.updateMany({
      data: { delete_source_psts: true },
    });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deletes every PST of a finished wave that delivered output and keeps the rows", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const b = t.pst("b.pst");
    const rowA = await t.row("a", a);
    await t.row("b", b);
    t.pdf("Email 0001.pdf");
    const result = await pruneWaveSourcePsts(rowA.id);
    assert.deepEqual(result, { deleted: 2 });
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
    assert.equal(
      await prisma.processedFile.count({
        where: { case_request_id: t.requestId },
      }),
      2,
    );
  });

  it("keeps everything while any PST of the wave has not finished", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const b = t.pst("b.pst");
    const rowA = await t.row("a", a);
    await t.row("b", b, { pdf_status: "failed" });
    t.pdf("Email 0001.pdf");
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), {
      deleted: 0,
      skipped: "not-finished",
    });
    assert.equal(fs.existsSync(a), true);
    assert.equal(fs.existsSync(b), true);
  });

  it("keeps the PSTs when the wave delivered no output", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const rowA = await t.row("a", a);
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), {
      deleted: 0,
      skipped: "no-output",
    });
    assert.equal(fs.existsSync(a), true);
  });

  it("does nothing when the setting is switched off", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const rowA = await t.row("a", a);
    t.pdf("Email 0001.pdf");
    await prisma.pipelineSettings.upsert({
      where: { id: "global" },
      create: { id: "global", delete_source_psts: false },
      update: { delete_source_psts: false },
    });
    try {
      assert.deepEqual(await pruneWaveSourcePsts(rowA.id), {
        deleted: 0,
        skipped: "disabled",
      });
      assert.equal(fs.existsSync(a), true);
    } finally {
      await prisma.pipelineSettings.update({
        where: { id: "global" },
        data: { delete_source_psts: true },
      });
    }
  });

  it("wave 2 needs output numbered above its base", async () => {
    const t = await setup({ wave: 2, renderBase: 3 });
    const a = t.pst("a.pst");
    const rowA = await t.row("a", a);
    for (const n of ["0001", "0002", "0003"]) t.pdf(`Email ${n}.pdf`);
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), {
      deleted: 0,
      skipped: "no-output",
    });
    assert.equal(fs.existsSync(a), true);
    t.pdf("Email 0004.pdf");
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), { deleted: 1 });
    assert.equal(fs.existsSync(a), false);
  });

  it("never deletes a file outside the request's PST folder", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const stray = path.join(t.staging, "Files", "stray.pst");
    fs.writeFileSync(stray, "x");
    const rowA = await t.row("a", a);
    await t.row("stray", stray);
    t.pdf("Email 0001.pdf");
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), { deleted: 1 });
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(stray), true);
  });

  it("keeps the PSTs when a kept email has no PDF (incomplete delivery)", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const rowA = await t.row("a", a);
    await t.kept(rowA.id, "1");
    await t.kept(rowA.id, "2");
    await t.kept(rowA.id, "3");
    t.pdf("Email 0001.pdf");
    t.pdf("Email 0002.pdf");
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), {
      deleted: 0,
      skipped: "incomplete-delivery",
    });
    assert.equal(fs.existsSync(a), true);
  });

  it("deletes once every kept email has a PDF", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const rowA = await t.row("a", a);
    await t.kept(rowA.id, "1");
    await t.kept(rowA.id, "2");
    t.pdf("Email 0001.pdf");
    t.pdf("Email 0002.pdf");
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), { deleted: 1 });
    assert.equal(fs.existsSync(a), false);
  });

  it("counts emails Render skipped on purpose as accounted for", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const rowA = await t.row("a", a);
    await t.kept(rowA.id, "1");
    await t.kept(rowA.id, "2");
    t.pdf("Email 0001.pdf");
    assert.deepEqual(
      await pruneWaveSourcePsts(rowA.id, { skippedByDesign: 1 }),
      {
        deleted: 1,
      },
    );
    assert.equal(fs.existsSync(a), false);
  });

  it("does not count attachment records or duplicates as kept emails", async () => {
    const t = await setup();
    const a = t.pst("a.pst");
    const rowA = await t.row("a", a);
    await t.kept(rowA.id, "1");
    await prisma.email.create({
      data: {
        id: `t-em-${tag}-${counter}-att`,
        file_id: rowA.id,
        email_hash: `hash-${tag}-${counter}-att`,
        ai_decision: "keep",
        is_attachment: 1,
      },
    });
    t.pdf("Email 0001.pdf");
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), { deleted: 1 });
  });

  it("only compares the current wave's kept emails with PDFs above its base", async () => {
    const t = await setup({ wave: 2, renderBase: 2 });
    const a = t.pst("a.pst");
    const rowA = await t.row("a", a);
    await t.kept(rowA.id, "1");
    t.pdf("Email 0001.pdf");
    t.pdf("Email 0002.pdf");
    // Only wave 1's PDFs exist: nothing delivered yet for this wave.
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), {
      deleted: 0,
      skipped: "no-output",
    });
    t.pdf("Email 0003.pdf");
    assert.deepEqual(await pruneWaveSourcePsts(rowA.id), { deleted: 1 });
  });

  it("ignores rows that do not belong to a managed request", async () => {
    const file = path.join(root, "legacy.pst");
    fs.writeFileSync(file, "x");
    const legacy = await prisma.processedFile.create({
      data: {
        id: `t-${tag}-legacy`,
        filepath: file,
        kind: "pst",
        ...finished,
      },
    });
    try {
      assert.deepEqual(await pruneWaveSourcePsts(legacy.id), {
        deleted: 0,
        skipped: "unmanaged",
      });
      assert.equal(fs.existsSync(file), true);
    } finally {
      await prisma.processedFile.deleteMany({ where: { id: legacy.id } });
    }
  });
});
