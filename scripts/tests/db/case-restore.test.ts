import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, describe, it } from "node:test";
import { restoreCaseByName } from "../../../src/lib/case-restore";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const name = `ZZ-RESTORE-${tag}`;
const id = `t-restore-${tag}`;

describe("restoreCaseByName", () => {
  after(async () => {
    await prisma.managedCase.deleteMany({ where: { id } });
    await prisma.$disconnect();
  });

  it("brings an archived case back and refuses an active or unknown one", async () => {
    await prisma.managedCase.create({
      data: {
        id,
        name,
        subject_name: "Test Subject",
        subject_email: "t@example.com",
        status: "archived",
        archived_at: new Date(),
      },
    });
    const restored = await restoreCaseByName(name);
    assert.equal(restored.id, id);
    const after = await prisma.managedCase.findUnique({ where: { id } });
    assert.equal(after?.status, "active");
    assert.equal(after?.archived_at, null);
    await assert.rejects(() => restoreCaseByName(name), /already active/);
    await assert.rejects(
      () => restoreCaseByName(`missing-${tag}`),
      /no longer in the system/,
    );
  });
});
