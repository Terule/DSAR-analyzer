/**
 * Read-only spike: runs the Files AI confidentiality screening through Amazon
 * Bedrock (Converse + forced tool use) so the verdicts, tokens and latency can
 * be compared with the current OpenAI batch step. It never touches the
 * database or the files, and it logs file names and verdicts only, never text.
 *
 *   node --import tsx scripts/maintenance/bedrock-spike.ts <requestOutputDir> \
 *     <subject name> [--model <bedrock model id>]... [--limit N] [--concurrency N]
 *
 * Credentials come from the standard AWS chain (~/.aws). Region eu-central-1.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
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
const DEFAULT_MODELS = ["eu.anthropic.claude-haiku-5-5"];
const TOOL_NAME = "files_screening_decision";

interface Item {
  kind: "Document" | "Message" | "Email";
  fileName: string;
  absPath: string;
}

function listPdfs(dir: string, kind: Item["kind"]): Item[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        e.name.toLowerCase().endsWith(".pdf") &&
        !e.name.startsWith("."),
    )
    .map((e) => ({ kind, fileName: e.name, absPath: path.join(dir, e.name) }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function converse(
  client: BedrockRuntimeClient,
  modelId: string,
  system: string,
  user: string,
  forced: boolean,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const started = Date.now();
      const response = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: system }],
          messages: [{ role: "user", content: [{ text: user }] }],
          inferenceConfig: { maxTokens: 300 },
          toolConfig: {
            tools: [
              {
                toolSpec: {
                  name: TOOL_NAME,
                  description: "Report the screening decision for this file.",
                  inputSchema: {
                    json: JSON.parse(
                      JSON.stringify(
                        FILES_AI_RESPONSE_FORMAT.json_schema.schema,
                      ),
                    ),
                  },
                },
              },
            ],
            toolChoice: forced ? { tool: { name: TOOL_NAME } } : { auto: {} },
          },
        }),
      );
      const block = response.output?.message?.content?.find((c) => c.toolUse);
      return {
        raw: block?.toolUse?.input
          ? JSON.stringify(block.toolUse.input)
          : undefined,
        ms: Date.now() - started,
        input: response.usage?.inputTokens ?? 0,
        output: response.usage?.outputTokens ?? 0,
        retries: attempt,
      };
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      if (
        name === "ThrottlingException" ||
        name === "ServiceUnavailableException"
      ) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
  return { raw: undefined, ms: 0, input: 0, output: 0, retries: 5 };
}

async function main() {
  const args = process.argv.slice(2);
  const outputDir = args.shift();
  const models: string[] = [];
  let limit = 50;
  let concurrency = 4;
  let expectedPath = "";
  const positional: string[] = [];
  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--model") models.push(args.shift() ?? "");
    else if (arg === "--limit") limit = Number(args.shift());
    else if (arg === "--concurrency") concurrency = Number(args.shift());
    else if (arg === "--expected") expectedPath = args.shift() ?? "";
    else positional.push(arg);
  }
  const subject = positional.join(" ").trim();
  if (!outputDir || !subject) {
    console.error(
      "Usage: bedrock-spike.ts <requestOutputDir> <subject name> [--model ID]... [--limit N] [--concurrency N]",
    );
    process.exit(2);
  }
  const expected: Record<string, { expect: string }> = expectedPath
    ? JSON.parse(fs.readFileSync(expectedPath, "utf8"))
    : {};
  const modelIds = models.length ? models : DEFAULT_MODELS;

  const items = [
    ...listPdfs(path.join(outputDir, "Documents"), "Document"),
    ...listPdfs(path.join(outputDir, "Messages"), "Message"),
    ...listPdfs(path.join(outputDir, "Emails"), "Email"),
  ].slice(0, limit);

  const criteria = { name: subject, email: "", aliases: [] as string[] };
  const system = buildFilesAiSystemPrompt(criteria, "client");
  const mentionTokens = subjectMentionTokens(criteria);
  const client = new BedrockRuntimeClient({ region: REGION });

  const prepared: { item: Item; user: string }[] = [];
  for (const item of items) {
    const text = await readPdfText(item.absPath);
    if (!text.trim()) {
      console.log(`no text: ${item.kind}/${item.fileName}`);
      continue;
    }
    const sample = buildSample(text, mentionTokens);
    prepared.push({
      item,
      user: buildFilesAiUserContent({
        fileName: item.fileName,
        kind: item.kind === "Message" ? "Message" : "Document",
        sampled: sample.sampled,
        text: sample.text,
      }),
    });
  }
  console.log(`Items sent to AI: ${prepared.length}\n`);

  for (const modelId of modelIds) {
    const results: string[] = new Array(prepared.length);
    let tokensIn = 0;
    let tokensOut = 0;
    let latency = 0;
    let retries = 0;
    let invalid = 0;
    let wrong = 0;
    let wrongDiscard = 0;
    let next = 0;
    const worker = async () => {
      while (next < prepared.length) {
        const index = next++;
        const { item, user } = prepared[index];
        const outcome = await converse(client, modelId, system, user, true);
        const judgement = parseFilesAiJudgement(outcome.raw);
        if (judgement.relevance === null) invalid++;
        const verdict = decideFilesAi({
          judgement,
          mode: "client",
          largeFile: false,
          subjectInvolved: true,
        });
        const want = expected[`${item.kind}/${item.fileName}`]?.expect;
        const mismatch = want && want !== verdict.verdict;
        if (mismatch) {
          wrong++;
          if (want === "discard") wrongDiscard++;
        }
        results[index] =
          `${mismatch ? "MISMATCH want=" + want + " " : ""}` +
          `${item.kind}/${item.fileName}: ${JSON.stringify(verdict)} ` +
          `[${judgement.relevance}/${judgement.sensitivity}]`;
        tokensIn += outcome.input;
        tokensOut += outcome.output;
        latency += outcome.ms;
        retries += outcome.retries;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(`=== ${modelId} ===`);
    for (const line of results) console.log(line);
    console.log(
      `mismatches=${wrong} (confidential kept: ${wrongDiscard}) invalid=${invalid} retries=${retries} avgLatency=${Math.round(latency / Math.max(1, prepared.length))}ms ` +
        `tokens in=${tokensIn} out=${tokensOut}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
