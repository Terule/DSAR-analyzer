import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";
import { resumeSharePointUploads } from "../../../src/lib/sharepoint-resume";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-sp-case-${tag}`;
let counter = 0;

async function artifact(opts: {
  status: string;
  heartbeatAgeMs?: number | null;
  caseType?: string;
}) {
  counter++;
  const id = `t-sp-${tag}-${counter}`;
  const localCaseId = opts.caseType === "client" ? `${caseId}-c` : caseId;
  const requestId = `t-sp-req-${tag}-${counter}`;
  await prisma.caseRequest.create({
    data: {
      id: requestId,
      case_id: localCaseId,
      name: `R${counter}`,
      scope: "mail",
      staging_path: `/tmp/${requestId}/s`,
      deliverable_path: `/tmp/${requestId}/d`,
    },
  });
  const fileId = `t-sp-file-${tag}-${counter}`;
  await prisma.processedFile.create({
    data: {
      id: fileId,
      filepath: `/tmp/${requestId}/s/PST/a.pst`,
      kind: "pst",
      case_request_id: requestId,
      status: "completed",
      ai_status: "completed",
      pdf_status: "completed",
    },
  });
  await prisma.sharePointUploadArtifact.create({
    data: {
      id,
      source_file_id: fileId,
      request_key: requestId,
      local_path: `/tmp/${requestId}/d/Emails/Email 0001.pdf`,
      relative_path: "Emails/Email 0001.pdf",
      file_size_bytes: BigInt(10),
      modified_at: BigInt(Date.now()),
      status: opts.status,
      heartbeat_at:
        opts.heartbeatAgeMs === undefined || opts.heartbeatAgeMs === null
          ? null
          : BigInt(Date.now() - opts.heartbeatAgeMs),
    },
  });
  return id;
}

const statusOf = async (id: string) =>
  (await prisma.sharePointUploadArtifact.findUniqueOrThrow({ where: { id } }))
    .status;

describe("resumeSharePointUploads", () => {
  before(async () => {
    for (const [id, type] of [
      [caseId, "employee"],
      [`${caseId}-c`, "client"],
    ]) {
      await prisma.managedCase.create({
        data: {
          id,
          name: `ZZ-SP-${tag}-${type}`,
          subject_name: "T",
          subject_email: "t@example.com",
          case_type: type,
        },
      });
    }
  });
  after(async () => {
    await prisma.sharePointUploadArtifact.deleteMany({
      where: {
        source_file: {
          case_request: { case_id: { in: [caseId, `${caseId}-c`] } },
        },
      },
    });
    await prisma.processedFile.deleteMany({
      where: { case_request: { case_id: { in: [caseId, `${caseId}-c`] } } },
    });
    await prisma.caseRequest.deleteMany({
      where: { case_id: { in: [caseId, `${caseId}-c`] } },
    });
    await prisma.managedCase.deleteMany({
      where: { id: { in: [caseId, `${caseId}-c`] } },
    });
    await prisma.$disconnect();
  });

  it("requeues an upload whose worker died (stale heartbeat) and starts the worker", async () => {
    const id = await artifact({
      status: "processing",
      heartbeatAgeMs: 16 * 60_000,
    });
    let started = 0;
    await resumeSharePointUploads(() => {
      started++;
    });
    assert.equal(await statusOf(id), "pending");
    assert.ok(started >= 1, "the worker was started");
  });

  it("requeues one that never recorded a heartbeat", async () => {
    const id = await artifact({ status: "processing", heartbeatAgeMs: null });
    await resumeSharePointUploads(() => {});
    assert.equal(await statusOf(id), "pending");
  });

  it("leaves an upload alone while its worker is alive (recent heartbeat)", async () => {
    const id = await artifact({ status: "processing", heartbeatAgeMs: 5_000 });
    await resumeSharePointUploads(() => {});
    assert.equal(await statusOf(id), "processing");
  });

  it("does not touch finished uploads", async () => {
    const id = await artifact({
      status: "completed",
      heartbeatAgeMs: 99 * 60_000,
    });
    await resumeSharePointUploads(() => {});
    assert.equal(await statusOf(id), "completed");
  });

  it("does not requeue uploads belonging to client cases", async () => {
    const id = await artifact({
      status: "processing",
      heartbeatAgeMs: 99 * 60_000,
      caseType: "client",
    });
    await resumeSharePointUploads(() => {});
    assert.equal(await statusOf(id), "processing");
  });
});
