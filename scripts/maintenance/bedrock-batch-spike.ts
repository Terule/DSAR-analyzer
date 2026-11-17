/**
 * Spike: one Bedrock batch job (Haiku 4.5) over a request folder, to check the
 * IAM, S3 and output format end to end. Use synthetic files only. It uploads
 * the JSONL, creates the job, waits, compares verdicts with an optional
 * expected manifest, and deletes the S3 objects it created. Record ids are
 * opaque (r-0001...); no file name or text is logged.
 *
 *   node --import tsx scripts/maintenance/bedrock-batch-spike.ts <requestOutputDir> \
 *     <subject name> [--expected expected.json] [--copies N] [--keep-objects]
 *
 * Env: BEDROCK_BATCH_BUCKET, BEDROCK_BATCH_ROLE_ARN (required).
 */
import fs from "node:fs";
import path from "node:path";
import {
  BedrockClient,
  CreateModelInvocationJobCommand,
  GetModelInvocationJobCommand,
} from "@aws-sdk/client-bedrock";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { readPdfText } from "../../src/lib/files-ai-extract";
import {
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
  decideFilesAi,
  FILES_AI_RESPONSE_FORMAT,
  parseFilesAiJudgement,
} from "../../src/lib/files-ai-prompt";
import { buildSample, subjectMentionTokens } from "../../src/lib/files-ai-text";

const REGION = process.env.AWS_REGION || "eu-central-1";
const MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const TOOL = "files_screening_decision";

async function main() {
  const args = process.argv.slice(2);
  const dir = args.shift();
  let expectedPath = "";
  let copies = 8;
  let keep = false;
  const positional: string[] = [];
  while (args.length) {
    const a = args.shift() as string;
    if (a === "--expected") expectedPath = args.shift() ?? "";
    else if (a === "--copies") copies = Number(args.shift());
    else if (a === "--keep-objects") keep = true;
    else positional.push(a);
  }
  const subject = positional.join(" ").trim();
  const bucket = process.env.BEDROCK_BATCH_BUCKET;
  const roleArn = process.env.BEDROCK_BATCH_ROLE_ARN;
  if (!dir || !subject || !bucket || !roleArn) {
    console.error(
      "Need <dir> <subject> and BEDROCK_BATCH_BUCKET / BEDROCK_BATCH_ROLE_ARN",
    );
    process.exit(2);
  }
  const expected: Record<string, { expect: string }> = expectedPath
    ? JSON.parse(fs.readFileSync(expectedPath, "utf8"))
    : {};

  const criteria = { name: subject, email: "", aliases: [] as string[] };
  const system = buildFilesAiSystemPrompt(criteria, "client");
  const mention = subjectMentionTokens(criteria);
  const files = fs
    .readdirSync(path.join(dir, "Documents"))
    .filter((f) => f.endsWith(".pdf"));
  const records: { id: string; key: string; line: string }[] = [];
  for (let c = 0; c < copies; c++) {
    for (const file of files) {
      const text = await readPdfText(path.join(dir, "Documents", file));
      const sample = buildSample(text, mention);
      const id = `r-${String(records.length + 1).padStart(4, "0")}`;
      records.push({
        id,
        key: `Document/${file}`,
        line: JSON.stringify({
          recordId: id,
          modelInput: {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 300,
            system,
            messages: [
              {
                role: "user",
                content: buildFilesAiUserContent({
                  fileName: file,
                  kind: "Document",
                  sampled: sample.sampled,
                  text: sample.text,
                }),
              },
            ],
            tools: [
              {
                name: TOOL,
                description: "Report the screening decision for this file.",
                input_schema: FILES_AI_RESPONSE_FORMAT.json_schema.schema,
              },
            ],
            tool_choice: { type: "tool", name: TOOL },
          },
        }),
      });
    }
  }
  console.log(`records: ${records.length}`);

  const s3 = new S3Client({ region: REGION });
  const bedrock = new BedrockClient({ region: REGION });
  const stamp = Date.now();
  const inputKey = `input/spike-${stamp}.jsonl`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: inputKey,
      Body: records.map((r) => r.line).join("\n"),
    }),
  );
  const created = await bedrock.send(
    new CreateModelInvocationJobCommand({
      jobName: `spike-${stamp}`,
      roleArn,
      modelId: MODEL,
      inputDataConfig: {
        s3InputDataConfig: { s3Uri: `s3://${bucket}/${inputKey}` },
      },
      outputDataConfig: {
        s3OutputDataConfig: { s3Uri: `s3://${bucket}/output/spike-${stamp}/` },
      },
    }),
  );
  const jobArn = created.jobArn as string;
  console.log(`job created: ${jobArn.split("/").pop()}`);

  let status = "";
  for (;;) {
    const job = await bedrock.send(
      new GetModelInvocationJobCommand({ jobIdentifier: jobArn }),
    );
    if (job.status !== status) {
      status = job.status ?? "";
      console.log(`${new Date().toISOString()} ${status} ${job.message ?? ""}`);
    }
    if (
      [
        "Completed",
        "Failed",
        "Stopped",
        "Expired",
        "PartiallyCompleted",
      ].includes(status)
    )
      break;
    await new Promise((r) => setTimeout(r, 30_000));
  }

  const prefix = `output/spike-${stamp}/`;
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );
  const keys = (listed.Contents ?? []).map((o) => o.Key as string);
  console.log(`output objects: ${keys.length}`);
  const byId = new Map(records.map((r) => [r.id, r.key]));
  let wrong = 0;
  let wrongKept = 0;
  let invalid = 0;
  let seen = 0;
  for (const key of keys.filter((k) => k.endsWith(".jsonl.out"))) {
    const body = await (
      await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    ).Body?.transformToString();
    for (const line of (body ?? "").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      seen++;
      const block = row.modelOutput?.content?.find(
        (c: { type: string }) => c.type === "tool_use",
      );
      const judgement = parseFilesAiJudgement(
        block ? JSON.stringify(block.input) : undefined,
      );
      if (judgement.relevance === null) invalid++;
      const verdict = decideFilesAi({
        judgement,
        mode: "client",
        largeFile: false,
        subjectInvolved: true,
      }).verdict;
      const want = expected[byId.get(row.recordId) ?? ""]?.expect;
      if (want && want !== verdict) {
        wrong++;
        if (want === "discard") wrongKept++;
      }
    }
  }
  console.log(
    `results=${seen} mismatches=${wrong} (confidential kept: ${wrongKept}) invalid=${invalid}`,
  );
  const final = await bedrock.send(
    new GetModelInvocationJobCommand({ jobIdentifier: jobArn }),
  );
  console.log(
    `status=${final.status} submitted=${final.submitTime?.toISOString()} end=${final.endTime?.toISOString()}`,
  );

  if (!keep) {
    for (const key of [inputKey, ...keys]) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
    console.log(`deleted ${keys.length + 1} S3 objects`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
