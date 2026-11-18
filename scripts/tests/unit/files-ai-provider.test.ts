import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FilesAiClient } from "../../../src/lib/files-ai";
import { configuredFilesAiClient } from "../../../src/lib/files-ai-provider";

const fakeBedrock: FilesAiClient = {
  async uploadBatchFile() {
    return "upload";
  },
  async createBatch() {
    return "create";
  },
  async retrieveBatch() {
    return { status: "completed" };
  },
  async readFile() {
    return "text";
  },
};

describe("configuredFilesAiClient", () => {
  it("returns the Bedrock client when AWS credentials exist", async () => {
    const client = await configuredFilesAiClient({
      bedrock: () => fakeBedrock,
      bedrockCredentials: async () => ({}),
    });
    assert.equal(await client.createBatch("x"), "create");
  });

  it("throws without AWS credentials, so callers send items to human review", async () => {
    await assert.rejects(
      configuredFilesAiClient({
        bedrock: () => fakeBedrock,
        bedrockCredentials: async () => {
          throw new Error("no credentials");
        },
      }),
      /No AWS credentials/,
    );
  });
});
