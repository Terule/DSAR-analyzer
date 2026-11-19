import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { maxConcurrentJobs, maxRecordsPerJob } from "./bedrock/config";
import { cancelBedrockRun, isBedrockId } from "./bedrock/files-ai-client";
import type { ParsedRequest } from "./bedrock/translate";
import { getCasePstFileIds } from "./case-utils";
import {
  EMAIL_CONFIDENTIALITY_PROMPT,
  SENSITIVITY_SCHEMA,
} from "./email-audit";
import { stripEmailSignature } from "./email-content";
import type { FilesAiClient } from "./files-ai";
import { configuredFilesAiClient } from "./files-ai-provider";
import { startMailScreen } from "./mail-screen";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";
import { buildSubjectTokens, mentionsSubject } from "./subject-rules";

/** Best-effort cancellation of external Batch work before a case is removed. */
export async function cancelAiBatchesForFiles(fileIds: string[]) {
  if (fileIds.length === 0) return;
  const batches = await prisma.processedFile.findMany({
    where: {
      id: { in: fileIds },
      batch_id: { not: null },
      ai_status: { in: ["processing", "batch_ready"] },
    },
    select: { batch_id: true },
  });
  await Promise.all(
    batches.map(({ batch_id }) =>
      batch_id && isBedrockId(batch_id)
        ? cancelBedrockRun(batch_id)
        : undefined,
    ),
  );
}
/** Output budget per request; the decision JSON is small. */
const MAX_COMPLETION_TOKENS_PER_REQUEST = 150;
/**
 * Largest payload sent for one email, in characters (about 100k tokens, well
 * inside Haiku's context). Past it the deep chain, which the rules say never
 * decides, is cut first; the first and second email are kept whole when they fit.
 */
const MAX_PAYLOAD_CHARS = 400_000;
export const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "dsar_audit_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "reason", "needs_second_pass", "sensitivity"],
      properties: {
        decision: { type: "string", enum: ["keep", "discard"] },
        reason: { type: "string", maxLength: 240 },
        needs_second_pass: { type: "boolean" },
        sensitivity: SENSITIVITY_SCHEMA,
      },
    },
  },
} as const;

export function stripPayloadSignatures(content: Record<string, unknown>): void {
  for (const key of ["first_email", "second_email"]) {
    const email = content[key];
    if (email && typeof email === "object" && "body" in email) {
      const body = (email as { body?: unknown }).body;
      if (typeof body === "string")
        (email as { body: string }).body = stripEmailSignature(body);
    }
  }
  const chain = content.rest_of_chain;
  if (chain && typeof chain === "object" && "text" in chain) {
    const text = (chain as { text?: unknown }).text;
    if (typeof text === "string")
      (chain as { text: string }).text = stripEmailSignature(text);
  }
}

/** Rough token estimate for display (about 4 characters per token). */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * The user message for one email: the payload without signatures, cut down to
 * MAX_PAYLOAD_CHARS when needed (chain first, then the bodies) instead of
 * discarding the email as "too large".
 */
export function buildEmailUserContent(
  content: Record<string, unknown>,
): string {
  stripPayloadSignatures(content);
  let userContent = JSON.stringify(content);
  if (userContent.length <= MAX_PAYLOAD_CHARS) return userContent;
  const cut = (value: unknown, keep: number) =>
    typeof value === "string" && value.length > keep
      ? `${value.slice(0, keep)}\n[truncated]`
      : value;
  const chain = content.rest_of_chain as { text?: unknown } | undefined;
  if (chain && "text" in chain) chain.text = cut(chain.text, 20_000);
  userContent = JSON.stringify(content);
  if (userContent.length <= MAX_PAYLOAD_CHARS) return userContent;
  for (const key of ["second_email", "first_email"]) {
    const email = content[key] as { body?: unknown } | null | undefined;
    if (email && "body" in email) email.body = cut(email.body, 150_000);
  }
  return JSON.stringify(content);
}

/** Tests inject a fake Bedrock client here; production never sets it. */
export const emailAiTestOverride: {
  client?: FilesAiClient;
  converse?: (request: ParsedRequest, modelId: string) => Promise<unknown>;
} = {};

/** The employee-case email audit prompt. Exported so spikes and tests use the exact text. */
export function buildEmailAuditSystemPrompt(criteria: {
  name: string;
  email: string;
  personalEmail?: string;
  aliases: string[];
}): string {
  return `You are an expert Legal AI performing a Data Subject Access Request (DSAR) compliance audit.
Target Data Subject: ${criteria.name}
Primary Email (work): ${criteria.email}${criteria.personalEmail ? `\nPersonal Email: ${criteria.personalEmail}` : ""}
Aliases: ${criteria.aliases.join(", ")}

INSTRUCTIONS:
You are receiving a JSON payload with these sections:
- first_email: { from, to, subject, body }
- second_email: { from, to, subject, body } | null
- rest_of_chain: { text }
- meta: { attachment_count, to_recipient_count }
- attachments: [{ filename, content_type, size_bytes }]

  Your PRIMARY objective is precision: avoid false positives.
  If uncertain, choose "discard".

Apply these HARD rules in order and evaluate mainly using first_email:

  1. [IMMEDIATE DISCARD]
If first_email.subject contains the full token words "Confidential", "Confidentiality", "Privileged", "CRO", or "CROs" -> discard.
Important: token boundary match only. Do NOT treat substrings like "MICROSOFT" as CRO.

  2. [STRONG KEEP SIGNALS]
The payload comes from a PDF whose chain runs from most recent (first_email) to oldest. first_email is the most recent email of the chain. Keep ONLY if at least one strong signal exists:
- Subject's primary or personal email appears in first_email.from.
- Subject's primary or personal email appears in first_email.to AND first_email has only one recipient.
- Subject name/alias/initials appear in first_email.body and the email is ABOUT the subject as a person: their own personal matters such as leave or time off, pay, health, a request, complaint or grievance, appraisal, feedback, discipline or employment status. An announcement or message about the subject (an award, promotion, welcome, departure or recognition) is about the subject even when it is sent to many people. Keep these even when the email only uses the first name. Do NOT keep when the subject is only mentioned in connection with a task or responsibility (for example "John prepared the report", "Maria will be responsible for the budget", "please contact Maria", an action item or an assignment).
- second_email.from is the subject, ONLY when (a) the subject's email was forwarded to someone else (the subject wrote to A, A forwarded it to B: first_email is A's forward and second_email is the subject's message), or (b) second_email is the subject's message and first_email is a direct reply in a thread with only two participants.
- Personal data about the subject, such as performance reviews, feedback or appraisals, is kept.

  3. [WEAK SIGNALS -> DISCARD]
  Do NOT keep when evidence is only weak/ambiguous, including:
  - Name appears once in disclaimer/signature/footer/contact list.
  - Partial name/substrings only (token boundary mismatch).
  - Generic references without clear linkage to the target subject.
- Subject appears only in rest_of_chain.text (deep in the chain), or only in a reply in a conversation with more than two participants, without a strong signal in first_email.

  4. [DEFAULT]
  If no strong signal is present -> discard.

${EMAIL_CONFIDENTIALITY_PROMPT}

Set needs_second_pass = true only when decision is "discard" and attachments may still contain relevant evidence (especially attached emails/documents).`;
}

export async function generateBatchFile(
  fileId: string,
  subjectCriteria: {
    name: string;
    email: string;
    personalEmail?: string;
    aliases: string[];
  },
  options?: { maxRecordsPerBatch?: number; client?: FilesAiClient },
) {
  const maxRecords = options?.maxRecordsPerBatch ?? maxRecordsPerJob();

  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { filepath: true, ai_started_at: true },
  });
  if (!row?.filepath) throw new Error("File not found");

  // Save criteria configuration securely to disk
  await prisma.processedFile.update({
    where: { id: fileId },
    data: {
      subject_name: subjectCriteria.name,
      subject_email: subjectCriteria.email,
      subject_aliases: subjectCriteria.aliases.join(", "),
    },
  });

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  const extractedPath =
    process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";

  const targetFolder = getPstWorkFolder({
    fileId,
    filepath: row.filepath,
    stagingPath,
    extractedPath,
  });
  const uniqueEmailsFolder = path.join(targetFolder, ".unique-emails");
  const jsonFolder = path.join(uniqueEmailsFolder, "json-files");
  if (!fs.existsSync(targetFolder))
    throw new Error("Extracted folder not found");
  if (!fs.existsSync(jsonFolder))
    throw new Error("JSON folder not found in .unique-emails/json-files");

  const batchDir = path.join(process.cwd(), "batches");
  if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true });

  // AI is case-level: audit the emails of EVERY PST file in this request in one
  // run (the JSON folder is shared). `fileId` is the coordinator row that holds
  // the live batch state and aggregate AI counters.
  const casePstIds = await getCasePstFileIds(fileId);

  const allFiles = fs
    .readdirSync(jsonFolder)
    .filter((f) => f.endsWith(".json"));

  const unprocessedRecords = await prisma.email.findMany({
    where: {
      file_id: { in: casePstIds },
      is_duplicate: 0,
      ai_decision: null,
      ai_batch_run_id: null,
    },
    select: { email_hash: true },
  });

  const unprocessedHashes = new Set(
    unprocessedRecords.map((r) => r.email_hash),
  );

  const systemPrompt = buildEmailAuditSystemPrompt(subjectCriteria);

  const subjectTokens = buildSubjectTokens(subjectCriteria);

  const batchRunId = randomUUID();
  await prisma.aiBatchRun.create({
    data: { id: batchRunId, coordinator_id: fileId, status: "claiming" },
  });

  const batchFilePath = path.join(
    batchDir,
    `batch_${fileId}_${Date.now()}.jsonl`,
  );
  const writer = fs.createWriteStream(batchFilePath);

  let estimatedTokens = estimateTokens(systemPrompt);
  let addedCount = 0;

  // Emails that never mention the subject are discarded without an AI call.
  // Written in groups: one query per 500 emails, not two per email.
  let preDiscards: string[] = [];
  const flushPreDiscards = async () => {
    if (preDiscards.length === 0) return;
    const hashes = preDiscards;
    preDiscards = [];
    await prisma.$transaction([
      prisma.email.updateMany({
        where: { email_hash: { in: hashes }, ai_decision: null },
        data: {
          ai_decision: "discard",
          ai_reason: "System Discard: Data subject not mentioned",
        },
      }),
      prisma.processedFile.update({
        where: { id: fileId },
        data: { ai_discarded_count: { increment: hashes.length } },
      }),
    ]);
  };

  // Pass 1: pick up to `maxRecords` emails for this job, remembering only hashes.
  const picked: string[] = [];
  for (const file of allFiles) {
    if (picked.length >= maxRecords) break;
    const hash = file.replace(".json", "");
    if (!unprocessedHashes.has(hash)) continue;
    const text = fs.readFileSync(path.join(jsonFolder, file), "utf-8");
    // The subject must be referenced somewhere in the payload (headers, body or
    // chain); otherwise the audit would discard it anyway.
    if (subjectTokens.length > 0 && !mentionsSubject(text, subjectTokens)) {
      preDiscards.push(hash);
      if (preDiscards.length >= 500) await flushPreDiscards();
      continue;
    }
    picked.push(hash);
  }
  await flushPreDiscards();

  // Claim before writing/uploading. This is the ownership barrier: another
  // parallel slot only selects rows whose claim is still null. Claims go in
  // groups, then the rows really owned by this run are read back.
  for (let i = 0; i < picked.length; i += 1000) {
    await prisma.email.updateMany({
      where: {
        email_hash: { in: picked.slice(i, i + 1000) },
        ai_decision: null,
        ai_batch_run_id: null,
      },
      data: { ai_batch_run_id: batchRunId },
    });
  }
  const owned = new Set(
    (
      await prisma.email.findMany({
        where: { ai_batch_run_id: batchRunId },
        select: { email_hash: true },
      })
    ).map((row) => row.email_hash),
  );

  // Pass 2: write the request lines of the claimed emails.
  for (const hash of picked) {
    if (!owned.has(hash)) continue;
    const content = JSON.parse(
      fs.readFileSync(path.join(jsonFolder, `${hash}.json`), "utf-8"),
    ) as Record<string, unknown>;
    const userContent = buildEmailUserContent(content);
    const request = {
      custom_id: hash,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_completion_tokens: MAX_COMPLETION_TOKENS_PER_REQUEST,
        response_format: RESPONSE_FORMAT,
      },
    };
    writer.write(`${JSON.stringify(request)}\n`);
    estimatedTokens += estimateTokens(userContent);
    addedCount++;
  }

  writer.end();
  await new Promise<void>((resolve) => writer.on("finish", () => resolve()));

  if (addedCount === 0) {
    const totalAiMs =
      typeof row.ai_started_at === "bigint"
        ? Math.max(0, Date.now() - Number(row.ai_started_at))
        : 0;
    await prisma.aiBatchRun.delete({ where: { id: batchRunId } });
    const activeBatches = await prisma.aiBatchRun.count({
      where: {
        coordinator_id: fileId,
        status: { in: ["claiming", "submitted", "processing"] },
      },
    });
    if (activeBatches === 0) await startMailScreen(fileId, totalAiMs);
    if (fs.existsSync(batchFilePath)) fs.unlinkSync(batchFilePath);
    return activeBatches === 0 ? "completed" : "no_work";
  }

  console.log(
    `[AI Engine] Uploading Chunk of ${addedCount} items (~${estimatedTokens} tokens) to Bedrock...`,
  );

  try {
    // Batch (Haiku 4.5) over 100 records, Converse (Haiku 5.5) below.
    const client =
      options?.client ??
      emailAiTestOverride.client ??
      (await configuredFilesAiClient());
    const externalBatchId = await client.createBatch(
      await client.uploadBatchFile(batchFilePath),
    );

    await prisma.$transaction([
      prisma.aiBatchRun.update({
        where: { id: batchRunId },
        data: {
          openai_batch_id: externalBatchId,
          status: "submitted",
          request_count: addedCount,
          estimated_tokens: estimatedTokens,
          submitted_at: new Date(),
        },
      }),
      // `batch_id` remains a UI/backwards-compatible pointer only.  The
      // durable ai_batch_runs rows are the source of truth for parallel work.
      prisma.processedFile.update({
        where: { id: fileId },
        data: {
          batch_id: externalBatchId,
          ai_status: "batch_ready",
          ai_batches_total: { increment: 1 },
        },
      }),
    ]);
    return "submitted";
  } catch (error) {
    await prisma.$transaction([
      prisma.email.updateMany({
        where: { ai_batch_run_id: batchRunId, ai_decision: null },
        data: { ai_batch_run_id: null },
      }),
      prisma.aiBatchRun.delete({ where: { id: batchRunId } }),
    ]);
    throw error;
  } finally {
    if (fs.existsSync(batchFilePath)) fs.unlinkSync(batchFilePath);
  }
}

/** Fill the bounded parallel window. Safe to call repeatedly from polling or
 * restart reconciliation: claimed email rows prevent overlapping submissions. */
export async function fillAiBatchSlots(
  fileId: string,
  subjectCriteria: {
    name: string;
    email: string;
    personalEmail?: string;
    aliases: string[];
  },
  options?: {
    maxRecordsPerBatch?: number;
    maxConcurrentBatches?: number;
    client?: FilesAiClient;
  },
): Promise<void> {
  const maxConcurrent = Math.max(
    1,
    options?.maxConcurrentBatches ?? maxConcurrentJobs(),
  );
  const active = await prisma.aiBatchRun.count({
    where: {
      coordinator_id: fileId,
      status: { in: ["claiming", "submitted", "processing"] },
    },
  });
  const slots = Math.max(0, maxConcurrent - active);
  for (let index = 0; index < slots; index++) {
    const result = await generateBatchFile(fileId, subjectCriteria, {
      maxRecordsPerBatch: options?.maxRecordsPerBatch,
      client: options?.client,
    });
    if (result !== "submitted") break;
  }
}
