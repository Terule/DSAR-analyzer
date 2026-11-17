import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  BedrockClient,
  CreateModelInvocationJobCommand,
  GetModelInvocationJobCommand,
} from "@aws-sdk/client-bedrock";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { FilesAiClient } from "../files-ai";
import {
  assertAllowedModel,
  BATCH_MODEL,
  BATCH_THRESHOLD,
  BEDROCK_REGION,
  batchSettings,
  CONVERSE_CONCURRENCY,
  CONVERSE_MODEL,
} from "./config";
import {
  type ParsedRequest,
  parseRequestLine,
  toBatchModelInput,
  toOpenAiOutputLine,
  toolInputFromModelOutput,
} from "./translate";

/** Id prefixes: they tell a later poll which backend owns a run (and keep ids unique). */
export const BEDROCK_BATCH_PREFIX = "bedrock-batch:";
export const BEDROCK_CONVERSE_PREFIX = "bedrock-converse:";

export function isBedrockId(id: string): boolean {
  return (
    id.startsWith(BEDROCK_BATCH_PREFIX) ||
    id.startsWith(BEDROCK_CONVERSE_PREFIX)
  );
}

/** Everything that talks to AWS, so the flow is testable without it. */
export interface BedrockDeps {
  /** One Converse call with a forced tool; returns the tool input or undefined. */
  converse(request: ParsedRequest, modelId: string): Promise<unknown>;
  putObject(bucket: string, key: string, body: string): Promise<void>;
  getObjectText(bucket: string, key: string): Promise<string>;
  listObjects(bucket: string, prefix: string): Promise<string[]>;
  deleteObject(bucket: string, key: string): Promise<void>;
  createJob(input: {
    jobName: string;
    roleArn: string;
    modelId: string;
    inputUri: string;
    outputUri: string;
  }): Promise<string>;
  getJob(jobArn: string): Promise<{ status: string; message?: string }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRYABLE = [
  "ThrottlingException",
  "ServiceUnavailableException",
  "ModelTimeoutException",
  "InternalServerException",
];

export function awsBedrockDeps(): BedrockDeps {
  const runtime = new BedrockRuntimeClient({ region: BEDROCK_REGION });
  const bedrock = new BedrockClient({ region: BEDROCK_REGION });
  const s3 = new S3Client({ region: BEDROCK_REGION });
  return {
    async converse(request, modelId) {
      assertAllowedModel(modelId);
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await runtime.send(
            new ConverseCommand({
              modelId,
              system: [{ text: request.system }],
              messages: [{ role: "user", content: [{ text: request.user }] }],
              inferenceConfig: { maxTokens: request.maxTokens },
              toolConfig: {
                tools: [
                  {
                    toolSpec: {
                      name: request.toolName,
                      description:
                        "Report the screening decision for this file.",
                      inputSchema: {
                        json: JSON.parse(JSON.stringify(request.schema)),
                      },
                    },
                  },
                ],
                toolChoice: { tool: { name: request.toolName } },
              },
            }),
          );
          return response.output?.message?.content?.find((b) => b.toolUse)
            ?.toolUse?.input;
        } catch (error) {
          const name = (error as { name?: string }).name ?? "";
          if (attempt >= 4 || !RETRYABLE.includes(name)) throw error;
          await sleep(1000 * 2 ** attempt);
        }
      }
    },
    async putObject(bucket, key, body) {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
      );
    },
    async getObjectText(bucket, key) {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      return (await object.Body?.transformToString()) ?? "";
    },
    async listObjects(bucket, prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        token = page.NextContinuationToken;
      } while (token);
      return keys;
    },
    async deleteObject(bucket, key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async createJob(input) {
      assertAllowedModel(input.modelId);
      const created = await bedrock.send(
        new CreateModelInvocationJobCommand({
          jobName: input.jobName,
          roleArn: input.roleArn,
          modelId: input.modelId,
          inputDataConfig: { s3InputDataConfig: { s3Uri: input.inputUri } },
          outputDataConfig: { s3OutputDataConfig: { s3Uri: input.outputUri } },
        }),
      );
      return created.jobArn as string;
    },
    async getJob(jobArn) {
      const job = await bedrock.send(
        new GetModelInvocationJobCommand({ jobIdentifier: jobArn }),
      );
      return { status: job.status ?? "", message: job.message };
    },
  };
}

interface BatchState {
  bucket: string;
  inputKey: string;
  outputPrefix: string;
  /** Opaque record id -> Files AI custom id. Only ever stored locally. */
  map: Record<string, string>;
  jobArn?: string;
}

/** `files-ai-<runId>.jsonl` -> `files-ai-<runId>`: every Bedrock artifact of a run shares it. */
function artifactBase(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, "");
}
const statePath = (base: string) => `${base}.bedrock.json`;
const converseOutPath = (base: string) => `${base}.bedrock-out.jsonl`;

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim());
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

/**
 * Bedrock behind the Files AI client seam. A run with more than BATCH_THRESHOLD
 * records goes to Bedrock Batch (Haiku 4.5); a smaller one is answered at once
 * with Converse (Haiku 5.5). Results come back in the OpenAI batch-output shape
 * the poller already reads, so the rest of the flow does not change.
 */
export function bedrockFilesAiClient(
  deps: BedrockDeps = awsBedrockDeps(),
): FilesAiClient {
  const cleanupBatch = async (base: string) => {
    const file = statePath(base);
    if (!fs.existsSync(file)) return;
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as BatchState;
    const keys = [
      state.inputKey,
      ...(await deps.listObjects(state.bucket, state.outputPrefix)),
    ];
    for (const key of keys) await deps.deleteObject(state.bucket, key);
  };

  return {
    async uploadBatchFile(filePath) {
      const lines = readLines(filePath);
      const base = artifactBase(filePath);
      if (lines.length <= BATCH_THRESHOLD) {
        return `${BEDROCK_CONVERSE_PREFIX}${filePath}`;
      }
      const { bucket } = batchSettings();
      const map: Record<string, string> = {};
      const records = lines.map((line, index) => {
        const request = parseRequestLine(line);
        const recordId = `r-${String(index + 1).padStart(6, "0")}`;
        map[recordId] = request.customId;
        return JSON.stringify({
          recordId,
          modelInput: toBatchModelInput(request),
        });
      });
      const token = randomUUID();
      const state: BatchState = {
        bucket,
        inputKey: `input/${token}.jsonl`,
        outputPrefix: `output/${token}/`,
        map,
      };
      await deps.putObject(bucket, state.inputKey, records.join("\n"));
      fs.writeFileSync(statePath(base), JSON.stringify(state));
      return `${BEDROCK_BATCH_PREFIX}${statePath(base)}`;
    },

    async createBatch(inputFileId) {
      if (inputFileId.startsWith(BEDROCK_CONVERSE_PREFIX)) {
        const filePath = inputFileId.slice(BEDROCK_CONVERSE_PREFIX.length);
        const requests = readLines(filePath).map(parseRequestLine);
        const out = await mapLimit(
          requests,
          CONVERSE_CONCURRENCY,
          async (r) => {
            let input: unknown;
            try {
              input = await deps.converse(r, CONVERSE_MODEL);
            } catch (error) {
              // No result for this item: the poller sends it to human review.
              console.error(
                "[Bedrock] Converse failed:",
                (error as { name?: string }).name,
              );
            }
            return toOpenAiOutputLine(r.customId, input);
          },
        );
        fs.writeFileSync(
          converseOutPath(artifactBase(filePath)),
          `${out.join("\n")}\n`,
        );
        return inputFileId;
      }
      const file = inputFileId.slice(BEDROCK_BATCH_PREFIX.length);
      const state = JSON.parse(fs.readFileSync(file, "utf8")) as BatchState;
      const { roleArn } = batchSettings();
      state.jobArn = await deps.createJob({
        jobName: `files-ai-${randomUUID().slice(0, 8)}`,
        roleArn,
        modelId: BATCH_MODEL,
        inputUri: `s3://${state.bucket}/${state.inputKey}`,
        outputUri: `s3://${state.bucket}/${state.outputPrefix}`,
      });
      fs.writeFileSync(file, JSON.stringify(state));
      return inputFileId;
    },

    async retrieveBatch(batchId) {
      if (batchId.startsWith(BEDROCK_CONVERSE_PREFIX)) {
        return { status: "completed", outputFileId: batchId };
      }
      const file = batchId.slice(BEDROCK_BATCH_PREFIX.length);
      const state = JSON.parse(fs.readFileSync(file, "utf8")) as BatchState;
      if (!state.jobArn) return { status: "in_progress" };
      const job = await deps.getJob(state.jobArn);
      if (["Completed", "PartiallyCompleted"].includes(job.status)) {
        return { status: "completed", outputFileId: batchId };
      }
      if (["Failed", "Stopped", "Expired"].includes(job.status)) {
        await cleanupBatch(file.replace(/\.bedrock\.json$/, ""));
        return { status: job.status === "Expired" ? "expired" : "failed" };
      }
      return { status: "in_progress" };
    },

    async readFile(fileId) {
      if (fileId.startsWith(BEDROCK_CONVERSE_PREFIX)) {
        const base = artifactBase(fileId.slice(BEDROCK_CONVERSE_PREFIX.length));
        return fs.readFileSync(converseOutPath(base), "utf8");
      }
      const file = fileId.slice(BEDROCK_BATCH_PREFIX.length);
      const base = file.replace(/\.bedrock\.json$/, "");
      const outPath = converseOutPath(base);
      // Cached after the first read: the S3 objects are deleted right away.
      if (fs.existsSync(outPath)) return fs.readFileSync(outPath, "utf8");
      const state = JSON.parse(fs.readFileSync(file, "utf8")) as BatchState;
      const lines: string[] = [];
      for (const key of await deps.listObjects(
        state.bucket,
        state.outputPrefix,
      )) {
        if (!key.endsWith(".jsonl.out")) continue;
        const text = await deps.getObjectText(state.bucket, key);
        for (const raw of text.split("\n")) {
          if (!raw.trim()) continue;
          const row = JSON.parse(raw) as {
            recordId?: string;
            modelOutput?: unknown;
          };
          const customId = row.recordId ? state.map[row.recordId] : undefined;
          if (!customId) continue;
          lines.push(
            toOpenAiOutputLine(
              customId,
              toolInputFromModelOutput(row.modelOutput),
            ),
          );
        }
      }
      fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
      await cleanupBatch(base);
      return `${lines.join("\n")}\n`;
    },
  };
}
