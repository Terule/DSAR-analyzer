/**
 * Judges again the Teams chats the AI discarded in a finished request, with the
 * current prompt (see "Teams chats" in `SENSITIVITY_RULES`), without running the
 * Files phase again. The discarded chat PDFs are still in `Discarded/Messages/`.
 *
 *   node --import tsx scripts/maintenance/rejudge-chats.ts --case JPF --request R1
 *   node --import tsx scripts/maintenance/rejudge-chats.ts --case JPF --request R1 --apply
 *
 * Without `--apply` it is read-only: it asks Haiku 5.5 (Converse, `eu.` profile)
 * about each chat and writes a report. With `--apply`, a chat that is now kept is
 * moved back to `Messages/`, numbered after the existing ones, its verdict and
 * audit-trail item are updated, the CSVs are rewritten and the new files are
 * queued for SharePoint. A chat the model cannot judge stays discarded.
 */
import fs from "node:fs";
import path from "node:path";
import { CONVERSE_MODEL } from "../../src/lib/bedrock/config";
import { awsBedrockDeps } from "../../src/lib/bedrock/files-ai-client";
import { refreshRequestLifecycle } from "../../src/lib/cases";
import { filesAiModeFor, largeFilePages } from "../../src/lib/files-ai";
import { readPdfSample } from "../../src/lib/files-ai-extract";
import {
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
  decideFilesAi,
  FILES_AI_RESPONSE_FORMAT,
  parseFilesAiJudgement,
} from "../../src/lib/files-ai-prompt";
import {
  buildSample,
  subjectClearlyInvolved,
  subjectMentionTokens,
} from "../../src/lib/files-ai-text";
import { exportAuditTrail, recordFileItems } from "../../src/lib/items";
import { prisma } from "../../src/lib/prisma";
import { mapLimit } from "../../src/lib/second-review";
import { queueSharePointArtifacts } from "../../src/lib/sharepoint-artifact-outbox";
import { startSharePointArtifactWorker } from "../../src/lib/sharepoint-artifact-queue";
import {
  finalizeStandaloneDeliverables,
  listFinalizedStandaloneDeliverables,
} from "../../src/lib/standalone-processor";
import { isTeamsExcerptText } from "../../src/lib/teams-chat";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const caseName = arg("--case");
const requestName = arg("--request");
const apply = process.argv.includes("--apply");
const limit = Number(arg("--limit") || 0);

interface Outcome {
  relPath: string;
  oldReason: string;
  verdict: "keep" | "discard" | "review" | "failed";
  reason: string;
  relevance?: string | null;
  sensitivity?: string | null;
  involved: boolean;
}

/**
 * Read-only: judges the Teams chat PDFs already delivered in `Messages/` with
 * the current rules and reports how many would now be discarded. The delivered
 * names are numbers, so the report is by file name.
 */
async function rejudgeKept(input: {
  deliverablePath: string;
  criteria: Parameters<typeof buildFilesAiSystemPrompt>[0];
  mode: Awaited<ReturnType<typeof filesAiModeFor>>;
  systemPrompt: string;
  mentionTokens: string[];
  converse: ReturnType<typeof awsBedrockDeps>["converse"];
}) {
  const dir = path.join(input.deliverablePath, "Messages");
  let names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".pdf"))
    .map((entry) => entry.name)
    .sort();
  if (limit > 0) names = names.slice(0, limit);
  const results: Array<[string, string, string, string]> = [];
  let chats = 0;
  let done = 0;
  await mapLimit(names, 4, async (name) => {
    const read = await readPdfSample(path.join(dir, name));
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${names.length} read`);
    if (!isTeamsExcerptText(read.text)) return;
    chats++;
    const sample = buildSample(read.text, input.mentionTokens);
    try {
      const answer = await input.converse(
        {
          customId: `rk-${name.slice(-12)}`,
          system: input.systemPrompt,
          user: buildFilesAiUserContent({
            fileName: name,
            kind: "Message",
            sampled: sample.sampled,
            text: sample.text,
          }),
          toolName: FILES_AI_RESPONSE_FORMAT.json_schema.name,
          schema: FILES_AI_RESPONSE_FORMAT.json_schema.schema as never,
          maxTokens: 200,
        },
        CONVERSE_MODEL,
      );
      const judgement = parseFilesAiJudgement(JSON.stringify(answer ?? {}));
      const decided = decideFilesAi({
        judgement,
        mode: input.mode,
        largeFile: read.totalPages > largeFilePages(),
        subjectInvolved: false,
      });
      results.push([
        name,
        decided.verdict,
        judgement.sensitivity ?? "",
        decided.reason.replace(/\s+/g, " "),
      ]);
    } catch {
      results.push([name, "failed", "", "Call failed."]);
    }
  });
  const reportPath = "/tmp/rejudge-kept-chats.tsv";
  fs.writeFileSync(
    reportPath,
    results
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map((row) => row.join("\t"))
      .join("\n"),
  );
  const tally = new Map<string, number>();
  for (const row of results) tally.set(row[1], (tally.get(row[1]) ?? 0) + 1);
  console.log(
    `${chats} chat excerpts among ${names.length} delivered Messages: ${[...tally].map(([k, v]) => `${k} ${v}`).join(", ")}. Report: ${reportPath}`,
  );
}

async function main() {
  if (!caseName || !requestName) {
    throw new Error("Usage: --case <CASE> --request <REQUEST> [--apply]");
  }
  const request = await prisma.caseRequest.findFirstOrThrow({
    where: { name: requestName, case: { name: caseName } },
    select: { id: true, deliverable_path: true },
  });
  const filesRow = await prisma.processedFile.findFirstOrThrow({
    where: { case_request_id: request.id, kind: "files" },
    select: {
      id: true,
      subject_name: true,
      subject_email: true,
      subject_personal_email: true,
      subject_aliases: true,
    },
  });
  const criteria = {
    name: filesRow.subject_name || "",
    email: filesRow.subject_email || "",
    personalEmail: filesRow.subject_personal_email || undefined,
    aliases: (filesRow.subject_aliases || "")
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean),
  };
  const mode = await filesAiModeFor(filesRow.id);
  const systemPrompt = buildFilesAiSystemPrompt(criteria, mode);
  const mentionTokens = subjectMentionTokens(criteria);
  const converse = awsBedrockDeps().converse;

  if (process.argv.includes("--kept")) {
    await rejudgeKept({
      deliverablePath: request.deliverable_path,
      criteria,
      mode,
      systemPrompt,
      mentionTokens,
      converse,
    });
    return;
  }

  let rows = await prisma.filesAiVerdict.findMany({
    where: {
      file_id: filesRow.id,
      verdict: "discard",
      rel_path: { startsWith: "Messages/" },
    },
    select: { id: true, rel_path: true, reason: true },
    orderBy: { rel_path: "asc" },
  });
  if (limit > 0) rows = rows.slice(0, limit);
  console.log(
    `${rows.length} discarded chats to judge again (${mode} case, ${apply ? "APPLY" : "dry run"}).`,
  );

  const outcomes: Outcome[] = [];
  let done = 0;
  await mapLimit(rows, 4, async (row) => {
    const absPath = path.join(
      request.deliverable_path,
      "Discarded",
      row.rel_path,
    );
    const base = { relPath: row.rel_path, oldReason: row.reason ?? "" };
    if (!fs.existsSync(absPath)) {
      outcomes.push({
        ...base,
        verdict: "failed",
        reason: "File not found in Discarded/.",
        involved: false,
      });
      return;
    }
    const read = await readPdfSample(absPath);
    if (!read.text.trim()) {
      outcomes.push({
        ...base,
        verdict: "review",
        reason: "No extractable text.",
        involved: false,
      });
      return;
    }
    const involved =
      mode === "employee" && subjectClearlyInvolved(read.text, criteria);
    const sample = buildSample(read.text, mentionTokens);
    try {
      const answer = await converse(
        {
          customId: `rj-${row.id.slice(-12)}`,
          system: systemPrompt,
          user: buildFilesAiUserContent({
            fileName: path.basename(row.rel_path),
            kind: "Message",
            sampled: sample.sampled,
            text: sample.text,
          }),
          toolName: FILES_AI_RESPONSE_FORMAT.json_schema.name,
          schema: FILES_AI_RESPONSE_FORMAT.json_schema.schema as never,
          maxTokens: 200,
        },
        CONVERSE_MODEL,
      );
      const judgement = parseFilesAiJudgement(JSON.stringify(answer ?? {}));
      if (judgement.relevance === null) {
        outcomes.push({
          ...base,
          verdict: "failed",
          reason: "The model gave no usable answer.",
          involved,
        });
      } else {
        const decided = decideFilesAi({
          judgement,
          mode,
          largeFile: read.totalPages > largeFilePages(),
          subjectInvolved: involved,
        });
        outcomes.push({
          ...base,
          verdict: decided.verdict,
          reason: decided.reason,
          relevance: judgement.relevance,
          sensitivity: judgement.sensitivity,
          involved,
        });
      }
    } catch (error) {
      outcomes.push({
        ...base,
        verdict: "failed",
        reason: `Call failed: ${(error as { name?: string }).name}`,
        involved,
      });
    }
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${rows.length} judged`);
  });

  const count = (verdict: Outcome["verdict"]) =>
    outcomes.filter((o) => o.verdict === verdict).length;
  const reportPath = `/tmp/rejudge-chats-${caseName}-${requestName}.tsv`;
  fs.writeFileSync(
    reportPath,
    outcomes
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((o) =>
        [
          o.relPath,
          o.verdict,
          o.sensitivity ?? "",
          o.relevance ?? "",
          o.reason.replace(/\s+/g, " "),
          o.oldReason.replace(/\s+/g, " "),
        ].join("\t"),
      )
      .join("\n"),
  );
  console.log(
    `Result: keep ${count("keep")}, discard ${count("discard")}, review ${count("review")}, could not judge ${count("failed")}. Report: ${reportPath}`,
  );

  if (!apply) return;

  const flipped = outcomes.filter((o) => o.verdict === "keep");
  if (flipped.length === 0) {
    console.log("Nothing to restore.");
    return;
  }
  const messagesDir = path.join(request.deliverable_path, "Messages");
  const documentsDir = path.join(request.deliverable_path, "Documents");
  const before = new Set(
    listFinalizedStandaloneDeliverables({ messagesDir, documentsDir }),
  );
  for (const o of flipped) {
    const from = path.join(request.deliverable_path, "Discarded", o.relPath);
    const to = path.join(request.deliverable_path, o.relPath);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
  finalizeStandaloneDeliverables({ messagesDir, documentsDir });
  const added = listFinalizedStandaloneDeliverables({
    messagesDir,
    documentsDir,
  }).filter((file) => !before.has(file));

  for (const o of flipped) {
    await prisma.filesAiVerdict.updateMany({
      where: { file_id: filesRow.id, rel_path: o.relPath },
      data: {
        verdict: "keep",
        reason: `Re-judged with the Teams chat rule: ${o.reason}`.slice(0, 240),
        relevance: o.relevance ?? null,
        sensitivity: o.sensitivity ?? null,
        reviewed_by_model: "haiku-5.5",
        resolved_at: new Date(),
      },
    });
  }
  await recordFileItems(
    filesRow.id,
    flipped.map((o) => ({
      relPath: o.relPath,
      label: o.relPath,
      state: "kept" as const,
      rule: "ai_file",
      reason: `Re-judged with the Teams chat rule: ${o.reason}`.slice(0, 240),
      decidedBy: "haiku-5.5",
    })),
  );
  await prisma.processedFile.update({
    where: { id: filesRow.id },
    data: {
      files_processed: { increment: flipped.length },
      files_skipped: { decrement: flipped.length },
    },
  });
  // The discard list of the whole request, as the apply step writes it.
  const remaining = await prisma.filesAiVerdict.findMany({
    where: { verdict: "discard", file: { case_request_id: request.id } },
    select: { rel_path: true, reason: true },
    orderBy: [{ file_id: "asc" }, { rel_path: "asc" }],
  });
  const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  fs.writeFileSync(
    path.join(request.deliverable_path, "Discarded", "verdicts.csv"),
    `${[
      "file,verdict,reason",
      ...remaining.map(
        (v) => `${csvCell(v.rel_path)},"discard",${csvCell(v.reason ?? "")}`,
      ),
    ].join("\n")}\n`,
  );
  await exportAuditTrail(request.id, request.deliverable_path);
  const queued = await queueSharePointArtifacts(filesRow.id, added);
  if (queued > 0) startSharePointArtifactWorker();
  await refreshRequestLifecycle(request.id);
  console.log(
    `Restored ${flipped.length} chats as ${added.length} numbered files; ${queued} queued for SharePoint.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
