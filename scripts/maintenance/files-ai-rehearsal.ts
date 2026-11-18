/**
 * Read-only dry run of the Files AI screening (relevance and confidentiality). It lists converted PDFs,
 * builds the exact prompts the AI step would send, and prints counts, token
 * and cost estimates. It never calls the AI service and never touches the database.
 *
 *   node --import tsx scripts/maintenance/files-ai-rehearsal.ts <requestOutputDir> \
 *     <subject name> [--alias <name>]... [--limit N] [--include-finalized]
 *
 * By default only this wave's unfinalized files are considered, as in a real
 * run. `--include-finalized` also takes numbered files (e.g. an already
 * delivered request) so a finished case can be sized.
 */
import fs from "node:fs";
import path from "node:path";
import {
  listFilesAiCandidates,
  readPdfText,
} from "../../src/lib/files-ai-extract";
import {
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
} from "../../src/lib/files-ai-prompt";
import { buildSample, subjectMentionTokens } from "../../src/lib/files-ai-text";

// Estimated Bedrock Batch input price per 1M tokens (Claude Haiku 4.5); check the
// Bedrock pricing page and override with INPUT_USD_PER_MILLION when it changes.
const INPUT_USD_PER_MILLION = Number(process.env.INPUT_USD_PER_MILLION) || 0.5;

function listAllPdfs(dir: string, kind: "Document" | "Message") {
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

async function main() {
  const args = process.argv.slice(2);
  const outputDir = args.shift();
  const flags = new Set<string>();
  const aliases: string[] = [];
  let limit = 200;
  const positional: string[] = [];
  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--alias") aliases.push(args.shift() ?? "");
    else if (arg === "--limit") limit = Number(args.shift());
    else if (arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  const subject = positional.join(" ").trim();
  if (!outputDir || !subject) {
    console.error(
      "Usage: files-ai-rehearsal.ts <requestOutputDir> <subject name> [--alias A] [--limit N] [--include-finalized]",
    );
    process.exit(2);
  }
  const dirs = {
    documentsDir: path.join(outputDir, "Documents"),
    messagesDir: path.join(outputDir, "Messages"),
  };
  const all = flags.has("--include-finalized")
    ? [
        ...listAllPdfs(dirs.documentsDir, "Document"),
        ...listAllPdfs(dirs.messagesDir, "Message"),
      ]
    : listFilesAiCandidates(dirs);
  // An evenly spread sample keeps the dry run quick on large requests.
  const step = Math.max(1, Math.floor(all.length / limit));
  const picked = all.filter((_, i) => i % step === 0).slice(0, limit);

  const criteria = { name: subject, email: "", aliases };
  // Employee mode is the longest prompt, so this is a conservative size.
  const systemPrompt = buildFilesAiSystemPrompt(criteria, "employee");
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);
  const systemTokens = estimateTokens(systemPrompt);
  const mentionTokens = subjectMentionTokens(criteria);

  let noText = 0;
  let sampled = 0;
  let tokens = 0;
  const examples: string[] = [];
  for (const file of picked) {
    const text = await readPdfText(file.absPath);
    if (!text.trim()) {
      noText++;
      continue;
    }
    const sample = buildSample(text, mentionTokens);
    if (sample.sampled) sampled++;
    const content = buildFilesAiUserContent({
      fileName: file.fileName,
      kind: file.kind,
      sampled: sample.sampled,
      text: sample.text,
    });
    tokens += systemTokens + estimateTokens(content) + 60;
    if (examples.length < 3) examples.push(content.slice(0, 600));
  }

  const judged = picked.length - noText;
  const perFile = judged > 0 ? tokens / judged : 0;
  const projectedTokens =
    perFile * (all.length - (noText / Math.max(1, picked.length)) * all.length);
  console.log(`Candidates in folder:      ${all.length}`);
  console.log(`Inspected (sample):        ${picked.length}`);
  console.log(
    `  no extractable text:     ${noText} (would go to human review)`,
  );
  console.log(`  large (sampled text):    ${sampled}`);
  console.log(`  sent to AI:              ${judged}`);
  console.log(`Avg tokens per request:    ${Math.round(perFile)}`);
  console.log(
    `Projected input tokens:    ${Math.round(projectedTokens).toLocaleString()}`,
  );
  console.log(
    `Projected cost (approx.):  $${((projectedTokens / 1e6) * INPUT_USD_PER_MILLION).toFixed(2)}`,
  );
  for (const [i, example] of examples.entries()) {
    console.log(`\n--- example prompt ${i + 1} ---\n${example}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
