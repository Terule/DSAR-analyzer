import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  getAiBatchSettings,
  updateAiBatchSettings,
} from "../../../src/lib/pipeline-settings";
import { prisma } from "../../../src/lib/prisma";

describe("Files workers setting", () => {
  let original = 6;
  before(async () => {
    original = (await getAiBatchSettings()).filesConcurrency ?? 6;
  });
  after(async () => {
    await prisma.pipelineSettings.updateMany({
      data: { files_concurrency: original },
    });
    await prisma.$disconnect();
  });

  it("defaults to 6 workers", async () => {
    await prisma.pipelineSettings.updateMany({
      data: { files_concurrency: 6 },
    });
    assert.equal((await getAiBatchSettings()).filesConcurrency, 6);
  });

  it("saves a new value and reads it back", async () => {
    const current = await getAiBatchSettings();
    const saved = await updateAiBatchSettings({
      ...current,
      filesConcurrency: 3,
    });
    assert.equal(saved.filesConcurrency, 3);
    assert.equal((await getAiBatchSettings()).filesConcurrency, 3);
    const row = await prisma.pipelineSettings.findUniqueOrThrow({
      where: { id: "global" },
    });
    assert.equal(row.files_concurrency, 3);
  });

  it("rejects an out-of-range value and keeps the previous one", async () => {
    const current = await getAiBatchSettings();
    await updateAiBatchSettings({ ...current, filesConcurrency: 4 });
    await assert.rejects(
      updateAiBatchSettings({ ...current, filesConcurrency: 99 }),
      /Files workers must be a whole number between 1 and 8/,
    );
    assert.equal((await getAiBatchSettings()).filesConcurrency, 4);
  });

  it("keeps other settings intact when only the workers change", async () => {
    const before = await getAiBatchSettings();
    await updateAiBatchSettings({ ...before, filesConcurrency: 5 });
    const after = await getAiBatchSettings();
    assert.equal(after.rereviewMinPKeep, before.rereviewMinPKeep);
    assert.equal(after.deleteSourcePsts, before.deleteSourcePsts);
    assert.equal(after.filesConcurrency, 5);
  });
});
