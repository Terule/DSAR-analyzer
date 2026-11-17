import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FilesAiClient } from "../../../src/lib/files-ai";
import { configuredFilesAiClient } from "../../../src/lib/files-ai-provider";

function fake(tag: string): FilesAiClient {
  return {
    async uploadBatchFile() {
      return `${tag}-upload`;
    },
    async createBatch() {
      return `${tag}-create`;
    },
    async retrieveBatch() {
      return { status: tag };
    },
    async readFile() {
      return tag;
    },
  };
}
const noOpenAi = async () => {
  throw new Error("no key");
};
const noCredentials = async () => {
  throw new Error("no credentials");
};

describe("configuredFilesAiClient", () => {
  it("submits with the configured provider and reads runs by their owner", async () => {
    const client = await configuredFilesAiClient(
      {},
      {
        provider: "bedrock",
        openAi: async () => fake("openai"),
        bedrock: () => fake("bedrock"),
        bedrockCredentials: async () => ({}),
      },
    );
    assert.equal(await client.uploadBatchFile("x"), "bedrock-upload");
    assert.equal(
      (await client.retrieveBatch("bedrock-batch:/p")).status,
      "bedrock",
    );
    assert.equal((await client.retrieveBatch("batch_123")).status, "openai");
  });

  it("refuses to submit when the configured provider has no credentials", async () => {
    await assert.rejects(
      configuredFilesAiClient(
        {},
        {
          provider: "openai",
          openAi: noOpenAi,
          bedrock: () => fake("bedrock"),
          bedrockCredentials: async () => ({}),
        },
      ),
    );
    await assert.rejects(
      configuredFilesAiClient(
        {},
        {
          provider: "bedrock",
          openAi: async () => fake("openai"),
          bedrockCredentials: noCredentials,
        },
      ),
    );
  });

  it("still polls Bedrock runs when the setting is openai and there is no OpenAI key", async () => {
    const client = await configuredFilesAiClient(
      { forPolling: true },
      {
        provider: "openai",
        openAi: noOpenAi,
        bedrock: () => fake("bedrock"),
        bedrockCredentials: async () => ({}),
      },
    );
    assert.equal(
      (await client.retrieveBatch("bedrock-converse:/p")).status,
      "bedrock",
    );
    // An OpenAI run cannot be read without a key, and says so.
    await assert.rejects(client.retrieveBatch("batch_123"));
  });

  it("still polls OpenAI runs when the setting is bedrock and there are no AWS credentials", async () => {
    const client = await configuredFilesAiClient(
      { forPolling: true },
      {
        provider: "bedrock",
        openAi: async () => fake("openai"),
        bedrockCredentials: noCredentials,
      },
    );
    assert.equal((await client.retrieveBatch("batch_123")).status, "openai");
  });

  it("fails polling only when no provider works", async () => {
    await assert.rejects(
      configuredFilesAiClient(
        { forPolling: true },
        {
          provider: "openai",
          openAi: noOpenAi,
          bedrockCredentials: noCredentials,
        },
      ),
    );
  });
});
