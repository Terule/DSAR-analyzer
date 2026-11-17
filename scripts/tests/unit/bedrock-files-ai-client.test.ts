import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertAllowedModel,
  BATCH_MODEL,
  CONVERSE_MODEL,
} from "../../../src/lib/bedrock/config";
import {
  type BedrockDeps,
  bedrockFilesAiClient,
} from "../../../src/lib/bedrock/files-ai-client";
import {
  parseRequestLine,
  toBatchModelInput,
} from "../../../src/lib/bedrock/translate";
import {
  buildFilesAiBatchRequest,
  parseFilesAiJudgement,
} from "../../../src/lib/files-ai-prompt";

process.env.BEDROCK_BATCH_BUCKET = "test-bucket";
process.env.BEDROCK_BATCH_ROLE_ARN = "arn:aws:iam::1:role/test";

const DECISION = { relevance: "relevant", sensitivity: "none", reason: "ok" };

function requestLine(customId: string): string {
  return JSON.stringify(
    buildFilesAiBatchRequest({
      customId,
      systemPrompt: "SYSTEM",
      userContent: "USER TEXT",
    }),
  );
}

function runFile(count: number): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-test-"));
  const file = path.join(dir, "files-ai-run1.jsonl");
  fs.writeFileSync(
    file,
    `${Array.from({ length: count }, (_, i) => requestLine(`case:Documents/Name ${i}.pdf`)).join("\n")}\n`,
  );
  return { dir, file };
}

class FakeDeps implements BedrockDeps {
  objects = new Map<string, string>();
  converseModels: string[] = [];
  jobStatus = "Submitted";
  createdJobs: { modelId: string; jobName: string }[] = [];
  failConverseFor = new Set<string>();
  async converse(request: { user: string; customId: string }, modelId: string) {
    this.converseModels.push(modelId);
    if (this.failConverseFor.has(request.customId)) throw new Error("boom");
    return DECISION;
  }
  async putObject(_bucket: string, key: string, body: string) {
    this.objects.set(key, body);
  }
  async getObjectText(_bucket: string, key: string) {
    return this.objects.get(key) ?? "";
  }
  async listObjects(_bucket: string, prefix: string) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }
  async deleteObject(_bucket: string, key: string) {
    this.objects.delete(key);
  }
  async createJob(input: {
    modelId: string;
    jobName: string;
    outputUri: string;
  }) {
    this.createdJobs.push(input);
    // The service writes its results under the output prefix.
    const prefix = input.outputUri.replace("s3://test-bucket/", "");
    const input0 = [...this.objects.entries()].find(([k]) =>
      k.startsWith("input/"),
    );
    const rows = (input0?.[1] ?? "")
      .split("\n")
      .map((line) => JSON.parse(line) as { recordId: string })
      .map((row) =>
        JSON.stringify({
          recordId: row.recordId,
          modelOutput: {
            content: [{ type: "tool_use", input: DECISION }],
          },
        }),
      );
    this.objects.set(`${prefix}job/part.jsonl.out`, rows.join("\n"));
    this.objects.set(`${prefix}job/manifest.json.out`, "{}");
    return "arn:aws:bedrock:eu-central-1:1:model-invocation-job/abc123";
  }
  async getJob() {
    return { status: this.jobStatus };
  }
}

describe("model guard", () => {
  it("allows only the two EU Haiku profiles", () => {
    assertAllowedModel(BATCH_MODEL);
    assertAllowedModel(CONVERSE_MODEL);
    assert.throws(() => assertAllowedModel("eu.anthropic.claude-sonnet-5"));
    assert.throws(() =>
      assertAllowedModel("global.anthropic.claude-haiku-5-5"),
    );
    assert.throws(() => assertAllowedModel("us.anthropic.claude-haiku-5-5"));
  });
});

describe("request translation", () => {
  it("turns an OpenAI chat line into a forced-tool Anthropic input", () => {
    const parsed = parseRequestLine(requestLine("id-1"));
    assert.equal(parsed.customId, "id-1");
    const input = toBatchModelInput(parsed) as {
      system: string;
      tool_choice: { type: string; name: string };
      messages: { content: string }[];
      max_tokens: number;
    };
    assert.equal(input.system, "SYSTEM");
    assert.equal(input.messages[0].content, "USER TEXT");
    assert.equal(input.tool_choice.type, "tool");
    assert.ok(input.max_tokens >= 300);
  });
});

describe("Bedrock Files AI client routing", () => {
  it("answers 100 records or fewer with Converse on Haiku 5.5", async () => {
    const deps = new FakeDeps();
    const client = bedrockFilesAiClient(deps);
    const { file } = runFile(100);
    const inputId = await client.uploadBatchFile(file);
    assert.match(inputId, /^bedrock-converse:/);
    const batchId = await client.createBatch(inputId);
    assert.equal(deps.converseModels.length, 100);
    assert.ok(deps.converseModels.every((m) => m === CONVERSE_MODEL));
    assert.equal(deps.createdJobs.length, 0);
    const status = await client.retrieveBatch(batchId);
    assert.equal(status.status, "completed");
    const out = (await client.readFile(status.outputFileId as string))
      .split("\n")
      .filter(Boolean);
    assert.equal(out.length, 100);
    const first = JSON.parse(out[0]);
    assert.equal(first.custom_id, "case:Documents/Name 0.pdf");
    assert.equal(
      parseFilesAiJudgement(first.response.body.choices[0].message.content)
        .relevance,
      "relevant",
    );
  });

  it("sends more than 100 records to Bedrock Batch on Haiku 4.5 with opaque ids", async () => {
    const deps = new FakeDeps();
    const client = bedrockFilesAiClient(deps);
    const { file } = runFile(101);
    const inputId = await client.uploadBatchFile(file);
    assert.match(inputId, /^bedrock-batch:/);
    const uploaded = [...deps.objects.values()][0];
    assert.ok(!uploaded.includes("Name 0.pdf"), "no file name in a record id");
    assert.ok(!uploaded.includes("case:"), "no custom id in the S3 input");
    assert.match(uploaded.split("\n")[0], /"recordId":"r-000001"/);
    const batchId = await client.createBatch(inputId);
    assert.equal(deps.createdJobs[0].modelId, BATCH_MODEL);
    assert.ok(!/Name|case/.test(deps.createdJobs[0].jobName));
    assert.equal((await client.retrieveBatch(batchId)).status, "in_progress");
  });

  it("reads batch output back to the original ids and deletes the S3 objects", async () => {
    const deps = new FakeDeps();
    const client = bedrockFilesAiClient(deps);
    const { file } = runFile(101);
    const batchId = await client.createBatch(
      await client.uploadBatchFile(file),
    );
    deps.jobStatus = "Completed";
    const status = await client.retrieveBatch(batchId);
    assert.equal(status.status, "completed");
    const text = await client.readFile(status.outputFileId as string);
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 101);
    assert.equal(lines[100].custom_id, "case:Documents/Name 100.pdf");
    assert.equal(deps.objects.size, 0, "input and output are deleted");
    // A second read (e.g. after a crash) comes from the local cache.
    assert.equal(await client.readFile(status.outputFileId as string), text);
  });

  it("reports failed and expired jobs and cleans up", async () => {
    for (const [bedrock, expected] of [
      ["Failed", "failed"],
      ["Expired", "expired"],
    ] as const) {
      const deps = new FakeDeps();
      const client = bedrockFilesAiClient(deps);
      const { file } = runFile(101);
      const batchId = await client.createBatch(
        await client.uploadBatchFile(file),
      );
      deps.jobStatus = bedrock;
      assert.equal((await client.retrieveBatch(batchId)).status, expected);
      assert.equal(deps.objects.size, 0);
    }
  });

  it("keeps waiting while the job is in progress", async () => {
    const deps = new FakeDeps();
    const client = bedrockFilesAiClient(deps);
    const { file } = runFile(101);
    const batchId = await client.createBatch(
      await client.uploadBatchFile(file),
    );
    for (const status of [
      "Submitted",
      "Validating",
      "Scheduled",
      "InProgress",
    ]) {
      deps.jobStatus = status;
      assert.equal((await client.retrieveBatch(batchId)).status, "in_progress");
    }
  });

  it("gives an item with no Converse result an empty answer, so it goes to review", async () => {
    const deps = new FakeDeps();
    deps.failConverseFor.add("case:Documents/Name 1.pdf");
    const client = bedrockFilesAiClient(deps);
    const { file } = runFile(3);
    const batchId = await client.createBatch(
      await client.uploadBatchFile(file),
    );
    const lines = (await client.readFile(batchId))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(lines[1].response.body.choices[0].message.content, "");
    assert.equal(
      parseFilesAiJudgement(lines[1].response.body.choices[0].message.content)
        .relevance,
      null,
    );
    assert.equal(
      parseFilesAiJudgement(lines[0].response.body.choices[0].message.content)
        .relevance,
      "relevant",
    );
  });
});
