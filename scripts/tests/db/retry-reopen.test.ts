import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { reopenRequestForRetry } from "../../../src/lib/cases";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-ro-case-${tag}`;
let counter = 0;

async function request(status: string) {
  counter++;
  const id = `t-ro-req-${tag}-${counter}`;
  await prisma.caseRequest.create({
    data: {
      id,
      case_id: caseId,
      name: `R${counter}`,
      scope: "mail",
      status,
      completed_at: status === "completed" ? new Date() : null,
      staging_path: `/tmp/${id}/s`,
      deliverable_path: `/tmp/${id}/d`,
    },
  });
  return id;
}

const read = (id: string) =>
  prisma.caseRequest.findUniqueOrThrow({ where: { id } });

describe("reopenRequestForRetry", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-RO-${tag}`,
        subject_name: "T",
        subject_email: "t@example.com",
      },
    });
  });
  after(async () => {
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("puts a finished request back to running so the dashboard and lifecycle follow it", async () => {
    const id = await request("completed");
    await reopenRequestForRetry(id);
    const after = await read(id);
    assert.equal(after.status, "running");
    assert.equal(after.completed_at, null);
  });

  it("does the same for a failed request", async () => {
    const id = await request("failed");
    await reopenRequestForRetry(id);
    assert.equal((await read(id)).status, "running");
  });

  it("leaves a request that is already running or has not started alone", async () => {
    const running = await request("running");
    const ready = await request("ready");
    await reopenRequestForRetry(running);
    await reopenRequestForRetry(ready);
    assert.equal((await read(running)).status, "running");
    assert.equal((await read(ready)).status, "ready");
  });

  it("ignores rows that do not belong to a request", async () => {
    await assert.doesNotReject(reopenRequestForRetry(null));
    await assert.doesNotReject(reopenRequestForRetry("no-such-request"));
  });
});
