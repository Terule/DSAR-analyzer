import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";
import { queueSharePointArtifacts } from "../../../src/lib/sharepoint-artifact-outbox";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const requestId = `t-req-${tag}`;
const wave1Id = `t-w1-${tag}`;
const wave2Id = `t-w2-${tag}`;
const artifactId = `t-art-${tag}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-outbox-"));
const staging = path.join(root, "Staging");
const extracted = path.join(root, "Results");
const caseName = `ZZ-SP-${tag}`;
const emailsDir = path.join(extracted, caseName, "R1", "Emails");
const deliverable = path.join(emailsDir, "Email 1.pdf");
const previousEnv = {
  STAGING_PATH: process.env.STAGING_PATH,
  EXTRACTED_PATH: process.env.EXTRACTED_PATH,
};

describe("queueSharePointArtifacts", () => {
  before(async () => {
    process.env.STAGING_PATH = staging;
    process.env.EXTRACTED_PATH = extracted;
    fs.mkdirSync(emailsDir, { recursive: true });
    fs.writeFileSync(deliverable, "pdf");
    const stat = fs.statSync(deliverable);
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: caseName,
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
        wave: 2,
        staging_path: path.join(staging, caseName, "R1"),
        deliverable_path: path.join(extracted, caseName, "R1"),
      },
    });
    for (const [id, wave] of [
      [wave1Id, 1],
      [wave2Id, 2],
    ] as const) {
      await prisma.processedFile.create({
        data: {
          id,
          kind: "pst",
          filename: `wave${wave}.pst`,
          filepath: path.join(
            staging,
            caseName,
            "R1",
            "PST",
            `wave${wave}.pst`,
          ),
          case_request_id: requestId,
          wave,
        },
      });
    }
    await prisma.sharePointUploadArtifact.create({
      data: {
        id: artifactId,
        source_file_id: wave1Id,
        request_key: `${caseName}/R1`,
        local_path: path.resolve(deliverable),
        relative_path: "Emails/Email 1.pdf",
        file_size_bytes: BigInt(stat.size),
        modified_at: BigInt(Math.floor(stat.mtimeMs)),
        status: "failed",
        attempts: 3,
        error_message: "boom",
      },
    });
  });

  after(async () => {
    await prisma.sharePointUploadArtifact.deleteMany({
      where: { source_file_id: { in: [wave1Id, wave2Id] } },
    });
    await prisma.processedFile.deleteMany({
      where: { id: { in: [wave1Id, wave2Id] } },
    });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("re-queues an earlier wave's failed artifact without taking it over", async () => {
    const queued = await queueSharePointArtifacts(wave2Id, [deliverable]);
    assert.equal(queued, 1);
    const artifact = await prisma.sharePointUploadArtifact.findUniqueOrThrow({
      where: { id: artifactId },
    });
    assert.equal(artifact.status, "pending");
    assert.equal(artifact.attempts, 0);
    assert.equal(artifact.error_message, null);
    assert.equal(artifact.source_file_id, wave1Id);
    // Deleting the wave-2 row (a re-run) must not cascade to the artifact.
    await prisma.processedFile.delete({ where: { id: wave2Id } });
    assert.equal(
      await prisma.sharePointUploadArtifact.count({
        where: { id: artifactId },
      }),
      1,
    );
  });
});
