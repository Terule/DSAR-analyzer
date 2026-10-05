import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";
import { resolveRenderBases } from "../../../src/lib/render-numbering";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
const emails = path.join(root, "Emails");

async function makeRequest(id: string, wave: number) {
  await prisma.caseRequest.create({
    data: {
      id,
      case_id: caseId,
      name: id,
      scope: "mail",
      staging_path: path.join(root, "s", id),
      deliverable_path: path.join(root, "d", id),
      wave,
    },
  });
}

describe("resolveRenderBases", () => {
  const wave1 = `t-r1-${tag}`;
  const wave2 = `t-r2-${tag}`;
  before(async () => {
    fs.mkdirSync(path.join(emails, "Warning"), { recursive: true });
    for (const n of ["0001", "0002", "0003"]) {
      fs.writeFileSync(path.join(emails, `Email ${n}.pdf`), "x");
    }
    fs.writeFileSync(path.join(emails, "Warning", "Warning 02.pdf"), "x");
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-WAVE-${tag}`,
        subject_name: "T",
        subject_email: "t@example.com",
      },
    });
    await makeRequest(wave1, 1);
    await makeRequest(wave2, 2);
  });
  after(async () => {
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns zero for a legacy row without a request", async () => {
    assert.deepEqual(await resolveRenderBases(null, emails), {
      email: 0,
      warning: 0,
    });
  });

  it("wave 1 never scans, even when partial PDFs already exist", async () => {
    assert.deepEqual(await resolveRenderBases(wave1, emails), {
      email: 0,
      warning: 0,
    });
  });

  it("wave 2 starts after the highest delivered number and persists it", async () => {
    assert.deepEqual(await resolveRenderBases(wave2, emails), {
      email: 3,
      warning: 2,
    });
    const stored = await prisma.caseRequest.findUniqueOrThrow({
      where: { id: wave2 },
    });
    assert.equal(stored.render_base, 3);
    assert.equal(stored.warning_base, 2);
  });

  it("a retry reuses the stored base even after more PDFs exist", async () => {
    fs.writeFileSync(path.join(emails, "Email 0004.pdf"), "x");
    fs.writeFileSync(path.join(emails, "Email 0005.pdf"), "x");
    assert.deepEqual(await resolveRenderBases(wave2, emails), {
      email: 3,
      warning: 2,
    });
  });

  it("an empty output folder yields zero for wave 2", async () => {
    const empty = `t-r3-${tag}`;
    await makeRequest(empty, 2);
    assert.deepEqual(
      await resolveRenderBases(empty, path.join(root, "nothing-here")),
      { email: 0, warning: 0 },
    );
  });
});
