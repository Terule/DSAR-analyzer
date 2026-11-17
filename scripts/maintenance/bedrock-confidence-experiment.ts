/**
 * Experiment: is the model's self-reported confidence a usable signal for deciding
 * which Haiku 4.5 DISCARDS to re-review with Haiku 5.5? Runs the real prompts
 * (documents: client mode, emails: employee audit) K times over synthetic items
 * with an extra `confidence` field (1-5) added only here, then reports how
 * confidence relates to correctness. Read-only; synthetic data only.
 *
 *   node --import tsx scripts/maintenance/bedrock-confidence-experiment.ts \
 *     --docs <requestDir> --docs-expected <expected.json> \
 *     --emails <cases.json> <subject name> <subject email> [--runs K] [--model ID]
 */
import fs from "node:fs";
import path from "node:path";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { buildEmailAuditSystemPrompt, RESPONSE_FORMAT } from "../../src/lib/ai";
import { applyConfidentiality } from "../../src/lib/email-audit";
import { readPdfText } from "../../src/lib/files-ai-extract";
import {
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
  decideFilesAi,
  FILES_AI_RESPONSE_FORMAT,
  parseFilesAiJudgement,
} from "../../src/lib/files-ai-prompt";
import { buildSample, subjectMentionTokens } from "../../src/lib/files-ai-text";

const PKEEP = process.argv.includes("--pkeep");
if (PKEEP) process.argv.splice(process.argv.indexOf("--pkeep"), 1);
const CONF_NOTE = PKEEP
  ? `

Also report "confidence": an integer from 0 to 100 giving the probability that this file SHOULD BE KEPT (delivered). 0 = certainly discard, 100 = certainly keep. Use the whole range: pick a middle value when the rules do not clearly decide.`
  : `

Also report "confidence": an integer from 1 to 5 for how sure you are of this decision. 5 = certain, the rules clearly decide it. 3 = plausible either way. 1 = mostly a guess.`;

interface Item {
  id: string;
  expect: "keep" | "discard";
  tool: string;
  schema: Record<string, unknown>;
  system: string;
  user: string;
  decide: (input: Record<string, unknown> | undefined) => "keep" | "discard";
}

function withConfidence(schema: Record<string, unknown>) {
  const copy = JSON.parse(JSON.stringify(schema));
  copy.properties.confidence = PKEEP
    ? { type: "integer", minimum: 0, maximum: 100 }
    : { type: "integer", minimum: 1, maximum: 5 };
  copy.required = [...copy.required, "confidence"];
  return copy;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const docsDir = opt("--docs");
  const docsExpected = opt("--docs-expected");
  const emailsFile = opt("--emails");
  const runs = Number(opt("--runs") ?? 8);
  const modelId =
    opt("--model") ?? "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
  const [name, email] = args;
  if (!name || !email) throw new Error("subject name and email are required");

  const items: Item[] = [];
  if (docsDir && docsExpected) {
    const expected = JSON.parse(fs.readFileSync(docsExpected, "utf8"));
    const criteria = { name, email, aliases: [] as string[] };
    const system = buildFilesAiSystemPrompt(criteria, "client") + CONF_NOTE;
    const mention = subjectMentionTokens(criteria);
    const dir = path.join(docsDir, "Documents");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".pdf"))) {
      const key = `Document/${file}`;
      if (!expected[key]) continue;
      const sample = buildSample(
        await readPdfText(path.join(dir, file)),
        mention,
      );
      items.push({
        id: `d:${file.replace(/\D/g, "")}`,
        expect: expected[key].expect,
        tool: "files_screening_decision",
        schema: withConfidence(
          FILES_AI_RESPONSE_FORMAT.json_schema.schema as never,
        ),
        system,
        user: buildFilesAiUserContent({
          fileName: file,
          kind: "Document",
          sampled: sample.sampled,
          text: sample.text,
        }),
        decide: (out) =>
          decideFilesAi({
            judgement: parseFilesAiJudgement(
              out ? JSON.stringify(out) : undefined,
            ),
            mode: "client",
            largeFile: false,
            subjectInvolved: true,
          }).verdict === "keep"
            ? "keep"
            : "discard",
      });
    }
  }
  if (emailsFile) {
    const cases = JSON.parse(fs.readFileSync(emailsFile, "utf8"));
    const system =
      buildEmailAuditSystemPrompt({ name, email, aliases: [] }) + CONF_NOTE;
    for (const c of cases) {
      items.push({
        id: `e:${c.id}`,
        expect: c.expect,
        tool: "dsar_audit_decision",
        schema: withConfidence(RESPONSE_FORMAT.json_schema.schema as never),
        system,
        user: JSON.stringify(c.payload),
        decide: (out) =>
          applyConfidentiality({
            decision: out?.decision === "keep" ? "keep" : "discard",
            reason: String(out?.reason ?? ""),
            needsSecondPass: false,
            sensitivity: out?.sensitivity,
          }).decision,
      });
    }
  }

  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || "eu-central-1",
  });
  type Row = { id: string; expect: string; got: string; conf: number };
  const rows: Row[] = [];
  const jobs = items.flatMap((item) =>
    Array.from({ length: runs }, () => item),
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < jobs.length) {
        const item = jobs[next++];
        try {
          const response = await client.send(
            new ConverseCommand({
              modelId,
              system: [{ text: item.system }],
              messages: [{ role: "user", content: [{ text: item.user }] }],
              inferenceConfig: { maxTokens: 300 },
              toolConfig: {
                tools: [
                  {
                    toolSpec: {
                      name: item.tool,
                      description: "Report the decision.",
                      inputSchema: { json: item.schema as never },
                    },
                  },
                ],
                toolChoice: { tool: { name: item.tool } },
              },
            }),
          );
          const out = response.output?.message?.content?.find((b) => b.toolUse)
            ?.toolUse?.input as Record<string, unknown> | undefined;
          rows.push({
            id: item.id,
            expect: item.expect,
            got: item.decide(out),
            conf: Number(out?.confidence ?? 0),
          });
        } catch (error) {
          console.error(`call failed for ${item.id}:`, (error as Error).name);
        }
      }
    }),
  );

  // Per item.
  console.log("item        expect   correct  avgConf(right) avgConf(wrong)");
  const ids = [...new Set(rows.map((r) => r.id))].sort();
  const avg = (xs: number[]) =>
    xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "-";
  for (const id of ids) {
    const r = rows.filter((x) => x.id === id);
    const right = r.filter((x) => x.got === x.expect);
    const wrong = r.filter((x) => x.got !== x.expect);
    console.log(
      `${id.padEnd(11)} ${r[0].expect.padEnd(8)} ${String(right.length).padStart(2)}/${r.length}     ${avg(right.map((x) => x.conf)).padStart(5)}          ${avg(wrong.map((x) => x.conf)).padStart(5)}`,
    );
  }
  // What matters: DISCARD decisions. A wrong discard is expect=keep, got=discard.
  const discards = rows.filter((r) => r.got === "discard");
  console.log(
    `\nDISCARD decisions: ${discards.length}, wrong (should be kept): ${discards.filter((r) => r.expect === "keep").length}`,
  );
  if (PKEEP) {
    console.log("p_keep bucket  discards  wrong");
    for (const [lo, hi] of [
      [0, 4],
      [5, 14],
      [15, 29],
      [30, 49],
      [50, 100],
    ]) {
      const at = discards.filter((r) => r.conf >= lo && r.conf <= hi);
      console.log(
        `${String(lo).padStart(3)}-${String(hi).padEnd(3)}        ${String(at.length).padStart(5)}   ${at.filter((r) => r.expect === "keep").length}`,
      );
    }
    const keeps = rows.filter((r) => r.got === "keep");
    console.log(
      `\nKEEP decisions: ${keeps.length}, wrong (should be discarded): ${keeps.filter((r) => r.expect === "discard").length}`,
    );
    for (const [lo, hi] of [
      [0, 49],
      [50, 79],
      [80, 94],
      [95, 100],
    ]) {
      const at = keeps.filter((r) => r.conf >= lo && r.conf <= hi);
      console.log(
        `${String(lo).padStart(3)}-${String(hi).padEnd(3)}        ${String(at.length).padStart(5)}   ${at.filter((r) => r.expect === "discard").length}`,
      );
    }
    return;
  }
  console.log("conf  discards  wrong  wrong%");
  for (let c = 1; c <= 5; c++) {
    const at = discards.filter((r) => r.conf === c);
    const bad = at.filter((r) => r.expect === "keep").length;
    console.log(
      `${c}     ${String(at.length).padStart(5)}   ${String(bad).padStart(4)}   ${at.length ? ((100 * bad) / at.length).toFixed(0) : "-"}%`,
    );
  }
  console.log("\nconfidence distribution over all calls:");
  for (let c = 1; c <= 5; c++)
    console.log(`${c}: ${rows.filter((r) => r.conf === c).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
