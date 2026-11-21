import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { cascadeDiscardedChats } from "../../../src/lib/items";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-cc-case-${tag}`;
const requestId = `t-cc-req-${tag}`;
const fileId = `t-cc-file-${tag}`;
const id = (name: string) => `t-cc-${tag}-${name}`;

describe("cascadeDiscardedChats", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-CC-${tag}`,
        subject_name: "Test Subject",
        subject_email: "t@example.com",
      },
    });
    await prisma.caseRequest.create({
      data: {
        id: requestId,
        case_id: caseId,
        name: "R1",
        scope: "files",
        status: "completed",
        staging_path: `/tmp/${tag}/s`,
        deliverable_path: `/tmp/${tag}/d`,
      },
    });
    await prisma.processedFile.create({
      data: {
        id: fileId,
        filename: "Files",
        filepath: `/tmp/${tag}/Files`,
        kind: "files",
        case_request_id: requestId,
      },
    });
    const chat = (name: string, state: string) => ({
      id: id(name),
      case_request_id: requestId,
      file_id: fileId,
      kind: "file",
      origin: "files_folder",
      state,
      decision_rule: "ai_file",
      decided_by: "haiku-5.5",
    });
    const message = (name: string, parent: string, state: string) => ({
      id: id(name),
      case_request_id: requestId,
      file_id: fileId,
      parent_id: id(parent),
      kind: "chat_message",
      origin: "files_folder",
      state,
      decision_rule: "chat_excerpt",
      decided_by: "rule",
    });
    await prisma.item.createMany({
      data: [
        chat("gone", "discarded"),
        chat("kept", "kept"),
        message("m1", "gone", "kept"),
        message("m2", "gone", "kept"),
        message("m3", "gone", "discarded"),
        message("m4", "kept", "kept"),
      ],
    });
  });

  after(async () => {
    await prisma.item.deleteMany({ where: { case_request_id: requestId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("discards the kept messages of a discarded chat, with an event, once", async () => {
    assert.equal(await cascadeDiscardedChats(requestId), 2);
    const states = async (names: string[]) =>
      (
        await prisma.item.findMany({
          where: { id: { in: names.map(id) } },
          orderBy: { id: "asc" },
        })
      ).map((item) => item.state);
    assert.deepEqual(await states(["m1", "m2", "m3"]), [
      "discarded",
      "discarded",
      "discarded",
    ]);
    // A message of a kept chat is left alone.
    assert.deepEqual(await states(["m4"]), ["kept"]);
    const moved = await prisma.item.findUniqueOrThrow({
      where: { id: id("m1") },
    });
    assert.equal(moved.decision_rule, "ai_file");
    assert.equal(moved.decided_by, "haiku-5.5");
    assert.equal(
      await prisma.itemEvent.count({
        where: { item_id: id("m1"), state: "discarded" },
      }),
      1,
    );
    assert.equal(await cascadeDiscardedChats(requestId), 0);
  });
});
