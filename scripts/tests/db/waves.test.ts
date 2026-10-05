import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { continueRequest, scanRequestSources } from "../../../src/lib/cases";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const requestId = `t-req-${tag}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "waves-db-"));
const staging = path.join(root, "Staging", "R1");
const deliverable = path.join(root, "Results", "R1");

describe("continue and wave-aware scan", () => {
  before(async () => {
    fs.mkdirSync(path.join(staging, "PST"), { recursive: true });
    fs.mkdirSync(path.join(deliverable, "Emails"), { recursive: true });
    fs.writeFileSync(path.join(staging, "PST", "Exchange.001.pst"), "w1");
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
        status: "ready",
        staging_path: staging,
        deliverable_path: deliverable,
      },
    });
  });

  after(async () => {
    const files = await prisma.processedFile.findMany({
      where: { case_request_id: requestId },
      select: { id: true },
    });
    await prisma.email.deleteMany({
      where: { file_id: { in: files.map((f) => f.id) } },
    });
    await prisma.processedFile.deleteMany({
      where: { case_request_id: requestId },
    });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("wave 1 scan creates rows with wave 1", async () => {
    const { sources } = await scanRequestSources(requestId);
    assert.equal(sources.length, 1);
    const row = await prisma.processedFile.findUniqueOrThrow({
      where: { id: sources[0].id },
    });
    assert.equal(row.wave, 1);
    // Pretend the wave finished, with an email hash recorded for dedup memory.
    await prisma.email.create({
      data: {
        id: `t-email-${tag}`,
        file_id: row.id,
        email_hash: `t-hash-${tag}`,
      },
    });
    await prisma.caseRequest.update({
      where: { id: requestId },
      data: { status: "completed" },
    });
  });

  it("continue refuses a request that is not completed", async () => {
    await prisma.caseRequest.update({
      where: { id: requestId },
      data: { status: "running" },
    });
    await assert.rejects(() => continueRequest(requestId, "mail"));
    await prisma.caseRequest.update({
      where: { id: requestId },
      data: { status: "completed" },
    });
  });

  it("continue bumps the wave once and a second call is refused", async () => {
    const next = await continueRequest(requestId, "files");
    assert.equal(next.wave, 2);
    assert.equal(next.wave_scope, "files");
    assert.equal(next.scope, "both");
    assert.equal(next.status, "ready");
    assert.equal(next.render_base, null);
    assert.ok(fs.existsSync(path.join(staging, "Files")));
    assert.ok(fs.existsSync(path.join(deliverable, "Documents")));
    await assert.rejects(() => continueRequest(requestId, "files"));
  });

  it("wave 2 scan keeps wave 1 rows and emails and requires only the wave's sources", async () => {
    // No Files content yet: the wave is files-only, so it must refuse.
    await assert.rejects(() => scanRequestSources(requestId));
    fs.writeFileSync(path.join(staging, "Files", "note.txt"), "w2");
    const { sources } = await scanRequestSources(requestId);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].kind, "files");
    const rows = await prisma.processedFile.findMany({
      where: { case_request_id: requestId },
      orderBy: { wave: "asc" },
    });
    assert.deepEqual(
      rows.map((r) => r.wave),
      [1, 2],
    );
    assert.equal(
      await prisma.email.count({ where: { email_hash: `t-hash-${tag}` } }),
      1,
    );
  });

  it("re-running a failed wave 2 removes leftovers above the stored base", async () => {
    fs.writeFileSync(path.join(deliverable, "Emails", "Email 01.pdf"), "x");
    fs.writeFileSync(path.join(deliverable, "Emails", "Email 02.pdf"), "x");
    fs.writeFileSync(path.join(deliverable, "Emails", "Email 03.pdf"), "x");
    await prisma.caseRequest.update({
      where: { id: requestId },
      data: { status: "failed", render_base: 1, warning_base: 0 },
    });
    await scanRequestSources(requestId);
    assert.deepEqual(fs.readdirSync(path.join(deliverable, "Emails")).sort(), [
      "Email 01.pdf",
    ]);
    const request = await prisma.caseRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    assert.equal(request.render_base, null);
    assert.equal(request.warning_base, null);
  });
});
