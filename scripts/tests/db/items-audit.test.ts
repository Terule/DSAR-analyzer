import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { syncEmailItems } from "../../../src/lib/items";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const fileId = `t-items-${tag}`;
const hash = (name: string) =>
  crypto.createHash("sha256").update(`${tag}-${name}`).digest("hex");

async function email(name: string, data: Record<string, unknown> = {}) {
  await prisma.email.create({
    data: {
      id: `t-items-e-${tag}-${name}`,
      file_id: fileId,
      email_hash: hash(name),
      is_duplicate: 0,
      ...data,
    },
  });
}

async function events(name: string) {
  return prisma.itemEvent.findMany({
    where: { item_id: hash(name) },
    orderBy: { created_at: "asc" },
  });
}

describe("items audit trail (shadow mode)", () => {
  before(async () => {
    await prisma.processedFile.create({
      data: { id: fileId, filepath: `/tmp/${fileId}.pst`, kind: "pst" },
    });
  });

  after(async () => {
    await prisma.item.deleteMany({ where: { file_id: fileId } });
    await prisma.email.deleteMany({ where: { file_id: fileId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
  });

  it("records a rule discard once, with its rule and reason", async () => {
    await email("kw", {
      ai_decision: "discard",
      ai_reason:
        "Pre-filter: Subject or body contains privileged/confidential keyword",
    });
    await syncEmailItems([hash("kw")]);
    await syncEmailItems([hash("kw")]);
    const item = await prisma.item.findUnique({ where: { id: hash("kw") } });
    assert.equal(item?.state, "discarded");
    assert.equal(item?.decision_rule, "keyword");
    assert.equal(item?.decided_by, "rule");
    assert.equal(item?.file_id, fileId);
    assert.equal(
      (await events("kw")).length,
      1,
      "no event when nothing changed",
    );
  });

  it("follows an email from pending to an AI discard to a kept second review", async () => {
    await email("ai");
    await syncEmailItems([hash("ai")]);
    await prisma.email.update({
      where: { email_hash: hash("ai") },
      data: { ai_decision: "discard", ai_reason: "Task mention only" },
    });
    await syncEmailItems([hash("ai")], { decidedBy: "haiku-4.5" });
    await prisma.email.update({
      where: { email_hash: hash("ai") },
      data: { ai_decision: "keep", ai_reason: "About the subject" },
    });
    await syncEmailItems([hash("ai")], { decidedBy: "haiku-5.5" });

    const trail = await events("ai");
    assert.deepEqual(
      trail.map((e) => [e.state, e.decision_rule, e.decided_by]),
      [
        ["pending", null, null],
        ["discarded", "ai_email", "haiku-4.5"],
        ["kept", "ai_email", "haiku-5.5"],
      ],
    );
    const item = await prisma.item.findUnique({ where: { id: hash("ai") } });
    assert.equal(item?.state, "kept");
  });

  it("marks attachments and keeps the parent link", async () => {
    await email("parent");
    await email("child", {
      is_attachment: 1,
      parent_email_hash: hash("parent"),
    });
    await syncEmailItems([hash("parent"), hash("child")]);
    const child = await prisma.item.findUnique({
      where: { id: hash("child") },
    });
    assert.equal(child?.origin, "attachment");
    assert.equal(child?.parent_id, hash("parent"));
  });

  it("never throws, even for hashes that do not exist", async () => {
    await syncEmailItems(["missing", ""]);
    assert.equal(
      await prisma.item.findUnique({ where: { id: "missing" } }),
      null,
    );
  });
});
