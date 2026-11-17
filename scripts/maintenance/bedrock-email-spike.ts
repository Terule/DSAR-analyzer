/**
 * Read-only spike: runs the employee-case email audit prompt (src/lib/ai.ts)
 * through Bedrock Converse over synthetic email payloads and compares the
 * folded decision (audit + confidentiality) with an expected keep/discard.
 *
 *   node --import tsx scripts/maintenance/bedrock-email-spike.ts <cases.json> \
 *     <subject name> <subject email> [--personal-email E] [--model ID]
 *
 * The cases file is a JSON array of { id, expect, why, payload }. Use
 * synthetic data only. Only ids and verdicts are printed.
 */
import fs from "node:fs";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { buildEmailAuditSystemPrompt, RESPONSE_FORMAT } from "../../src/lib/ai";
import { applyConfidentiality } from "../../src/lib/email-audit";

const TOOL = "dsar_audit_decision";

async function main() {
  const args = process.argv.slice(2);
  const [file, name, email] = args.splice(0, 3);
  let personalEmail: string | undefined;
  let modelId = "eu.anthropic.claude-haiku-5-5";
  while (args.length) {
    const a = args.shift();
    if (a === "--personal-email") personalEmail = args.shift();
    else if (a === "--model") modelId = args.shift() ?? modelId;
  }
  if (!file || !name || !email) {
    console.error(
      "Usage: bedrock-email-spike.ts <cases.json> <name> <email> [--personal-email E] [--model ID]",
    );
    process.exit(2);
  }
  const cases = JSON.parse(fs.readFileSync(file, "utf8")) as {
    id: string;
    expect: string;
    why: string;
    payload: unknown;
  }[];
  const system = buildEmailAuditSystemPrompt({
    name,
    email,
    personalEmail,
    aliases: [],
  });
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || "eu-central-1",
  });
  let wrong = 0;
  let wrongKept = 0;
  for (const c of cases) {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: [
          { role: "user", content: [{ text: JSON.stringify(c.payload) }] },
        ],
        inferenceConfig: { maxTokens: 300 },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: TOOL,
                description: "Report the audit decision for this email.",
                inputSchema: {
                  json: JSON.parse(
                    JSON.stringify(RESPONSE_FORMAT.json_schema.schema),
                  ),
                },
              },
            },
          ],
          toolChoice: { tool: { name: TOOL } },
        },
      }),
    );
    const out = response.output?.message?.content?.find((b) => b.toolUse)
      ?.toolUse?.input as Record<string, unknown> | undefined;
    const folded = applyConfidentiality({
      decision: out?.decision === "keep" ? "keep" : "discard",
      reason: String(out?.reason ?? ""),
      needsSecondPass: false,
      sensitivity: out?.sensitivity,
    });
    const bad = folded.decision !== c.expect;
    if (bad) {
      wrong++;
      if (c.expect === "discard") wrongKept++;
    }
    console.log(
      `${bad ? "MISMATCH " : ""}${c.id} want=${c.expect} got=${folded.decision} [${c.why}] ${folded.reason.slice(0, 120)}`,
    );
  }
  console.log(
    `\nmismatches=${wrong} (confidential/irrelevant kept: ${wrongKept}) of ${cases.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
