import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  getAiBatchSettings,
  updateAiBatchSettings,
} from "../../../src/lib/pipeline-settings";
import { prisma } from "../../../src/lib/prisma";

describe("Files AI setting", () => {
  let original = true;
  before(async () => {
    original = (await getAiBatchSettings()).filesAiEnabled ?? true;
  });
  after(async () => {
    await prisma.pipelineSettings.updateMany({
      data: { files_ai_enabled: original },
    });
    await prisma.$disconnect();
  });

  it("defaults to on", async () => {
    await prisma.pipelineSettings.updateMany({
      data: { files_ai_enabled: true },
    });
    assert.equal((await getAiBatchSettings()).filesAiEnabled, true);
  });

  it("saves false and reads it back", async () => {
    const current = await getAiBatchSettings();
    const saved = await updateAiBatchSettings({
      ...current,
      filesAiEnabled: false,
    });
    assert.equal(saved.filesAiEnabled, false);
    const row = await prisma.pipelineSettings.findUniqueOrThrow({
      where: { id: "global" },
    });
    assert.equal(row.files_ai_enabled, false);
    assert.equal((await getAiBatchSettings()).filesAiEnabled, false);
  });
});
