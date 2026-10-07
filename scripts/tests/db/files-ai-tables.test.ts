import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const fileId = `t-fai-file-${tag}`;

describe("Files AI tables", () => {
  after(async () => {
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    await prisma.$disconnect();
  });

  it("stores verdicts and runs and cascades when the file is deleted", async () => {
    await prisma.processedFile.create({
      data: { id: fileId, filename: "Files", kind: "files" },
    });
    await prisma.filesAiBatchRun.create({
      data: { id: `run-${tag}`, file_id: fileId, status: "submitted" },
    });
    await prisma.filesAiVerdict.createMany({
      data: [
        {
          id: `${fileId}:Documents/a.pdf`,
          file_id: fileId,
          rel_path: "Documents/a.pdf",
          batch_run_id: `run-${tag}`,
        },
        {
          id: `${fileId}:Messages/b.pdf`,
          file_id: fileId,
          rel_path: "Messages/b.pdf",
          verdict: "keep",
          reason: "ok",
        },
      ],
    });
    assert.equal(
      await prisma.filesAiVerdict.count({
        where: { file_id: fileId, verdict: null },
      }),
      1,
    );

    await prisma.processedFile.delete({ where: { id: fileId } });
    assert.equal(
      await prisma.filesAiVerdict.count({ where: { file_id: fileId } }),
      0,
    );
    assert.equal(
      await prisma.filesAiBatchRun.count({ where: { file_id: fileId } }),
      0,
    );
  });

  it("keeps a verdict when its batch run is deleted", async () => {
    await prisma.processedFile.create({
      data: { id: fileId, filename: "Files", kind: "files" },
    });
    await prisma.filesAiBatchRun.create({
      data: { id: `run2-${tag}`, file_id: fileId },
    });
    await prisma.filesAiVerdict.create({
      data: {
        id: `${fileId}:Documents/c.pdf`,
        file_id: fileId,
        rel_path: "Documents/c.pdf",
        batch_run_id: `run2-${tag}`,
      },
    });
    await prisma.filesAiBatchRun.delete({ where: { id: `run2-${tag}` } });
    const verdict = await prisma.filesAiVerdict.findUniqueOrThrow({
      where: { id: `${fileId}:Documents/c.pdf` },
    });
    assert.equal(verdict.batch_run_id, null);
  });
});
