import fs from "node:fs";
import path from "node:path";
import { encodingForModel } from "js-tiktoken";
import OpenAI from "openai";
import { getCasePstFileIds, markCaseAiCompleted } from "./case-utils";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL_NAME = "gpt-4o-mini";
const TOKENIZER = encodingForModel(MODEL_NAME);

// Enforce max enqueued rate headroom
export const DEFAULT_MAX_TOKENS_PER_BATCH = 900_000;
const MAX_COMPLETION_TOKENS_PER_REQUEST = 150;
const CHAT_MESSAGE_OVERHEAD_TOKENS = 12;
const REQUEST_OVERHEAD_TOKENS = 24;
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "dsar_audit_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "reason", "needs_second_pass"],
      properties: {
        decision: { type: "string", enum: ["keep", "discard"] },
        reason: { type: "string", maxLength: 240 },
        needs_second_pass: { type: "boolean" },
      },
    },
  },
} as const;

function countTokens(text: string): number {
  return TOKENIZER.encode(text).length;
}

// Cache of per-email userContent token counts, keyed by email hash. A payload's
// token count is content-stable, so this avoids re-encoding the same payload
// across successive batch chunks within a run.
const userContentTokenCache = new Map<string, number>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Broad "is the subject mentioned at all" token set: full name, first/last name
// parts, aliases, email and its local-part. Used only to skip emails that don't
// reference the subject ANYWHERE (headers, body or chain) — a guaranteed discard
// that GPT would also reject, so we save the API call.
function buildSubjectSearchTokens(criteria: {
  name: string;
  email: string;
  personalEmail?: string;
  aliases: string[];
}): string[] {
  const tokens = new Set<string>();
  const name = (criteria.name || "").trim().toLowerCase();
  if (name) {
    tokens.add(name);
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      if (first.length >= 3) tokens.add(first);
      if (last.length >= 3) tokens.add(last);
    }
  }
  for (const alias of criteria.aliases || []) {
    const a = alias.trim().toLowerCase();
    if (a) tokens.add(a);
  }
  const email = (criteria.email || "").trim().toLowerCase();
  if (email) {
    tokens.add(email);
    const local = email.split("@")[0];
    if (local && local.length >= 3) tokens.add(local);
  }
  const personalEmail = (criteria.personalEmail || "").trim().toLowerCase();
  if (personalEmail) {
    tokens.add(personalEmail);
    const personalLocal = personalEmail.split("@")[0];
    if (personalLocal && personalLocal.length >= 3) tokens.add(personalLocal);
  }
  return Array.from(tokens).filter(Boolean);
}

export async function generateBatchFile(
  fileId: string,
  subjectCriteria: {
    name: string;
    email: string;
    personalEmail?: string;
    aliases: string[];
  },
  options?: { maxTokensPerBatch?: number },
) {
  const maxTokensPerBatch =
    options?.maxTokensPerBatch && options.maxTokensPerBatch > 0
      ? Math.floor(options.maxTokensPerBatch)
      : DEFAULT_MAX_TOKENS_PER_BATCH;

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
    },
    select: { email_hash: true },
  });

  const unprocessedHashes = new Set(
    unprocessedRecords.map((r) => r.email_hash),
  );

  const systemPrompt = `You are an expert Legal AI performing a Data Subject Access Request (DSAR) compliance audit.
Target Data Subject: ${subjectCriteria.name}
Primary Email (work): ${subjectCriteria.email}${subjectCriteria.personalEmail ? `\nPersonal Email: ${subjectCriteria.personalEmail}` : ""}
Aliases: ${subjectCriteria.aliases.join(", ")}

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
  Keep ONLY if at least one strong signal exists:
- Subject's primary or personal email appears in first_email.from.
- Subject's primary or personal email appears in first_email.to AND first_email has only one recipient.
- Subject name/alias/initials appear in first_email.body with clear substantive relation.
- second_email.from is the subject (forwarded chain from subject).

  3. [WEAK SIGNALS -> DISCARD]
  Do NOT keep when evidence is only weak/ambiguous, including:
  - Name appears once in disclaimer/signature/footer/contact list.
  - Partial name/substrings only (token boundary mismatch).
  - Generic references without clear linkage to the target subject.
- Subject appears only in rest_of_chain.text without strong first/second email evidence.

  4. [DEFAULT]
  If no strong signal is present -> discard.

Set needs_second_pass = true only when decision is "discard" and attachments may still contain relevant evidence (especially attached emails/documents).`;

  // Precompute the constant per-request token overhead ONCE (previously the
  // system prompt was re-encoded for every email) and the subject mention
  // patterns used by the cheap pre-AI filter.
  const fixedOverheadTokens =
    countTokens(systemPrompt) +
    countTokens(JSON.stringify(RESPONSE_FORMAT)) +
    CHAT_MESSAGE_OVERHEAD_TOKENS +
    REQUEST_OVERHEAD_TOKENS +
    MAX_COMPLETION_TOKENS_PER_REQUEST;

  const subjectTokens = buildSubjectSearchTokens(subjectCriteria);
  const subjectPatterns = subjectTokens.map(
    (t) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(t)}($|[^a-z0-9])`, "i"),
  );

  const batchFilePath = path.join(
    batchDir,
    `batch_${fileId}_${Date.now()}.jsonl`,
  );
  const writer = fs.createWriteStream(batchFilePath);

  let currentTokenCount = 0;
  let addedCount = 0;

  for (const file of allFiles) {
    const hash = file.replace(".json", "");

    if (!unprocessedHashes.has(hash)) continue;

    const filePath = path.join(jsonFolder, file);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const userContent = JSON.stringify(content);

    // Pre-filter: skip the AI call entirely when the subject is not referenced
    // ANYWHERE in the payload (headers, body or chain). GPT would discard these
    // anyway, so this saves the API cost with no change in outcome.
    if (
      subjectPatterns.length > 0 &&
      !subjectPatterns.some((re) => re.test(userContent))
    ) {
      await prisma.$transaction([
        prisma.email.updateMany({
          where: { email_hash: hash },
          data: {
            ai_decision: "discard",
            ai_reason: "System Discard: Data subject not mentioned",
          },
        }),
        prisma.processedFile.update({
          where: { id: fileId },
          data: { ai_discarded_count: { increment: 1 } },
        }),
      ]);
      continue;
    }

    let userTokens = userContentTokenCache.get(hash);
    if (userTokens === undefined) {
      userTokens = countTokens(userContent);
      userContentTokenCache.set(hash, userTokens);
    }
    const estimatedTokens = fixedOverheadTokens + userTokens;

    if (estimatedTokens > maxTokensPerBatch) {
      console.log(
        `[AI Engine] Warning: Email ${hash} exceeds max tokens on its own (${estimatedTokens} > ${maxTokensPerBatch}). Discarding...`,
      );

      // 🚨 CRITICAL FIX: Ensure skipped oversized files are marked as discarded so they don't infinite-loop!
      await prisma.$transaction([
        prisma.email.updateMany({
          where: { email_hash: hash },
          data: {
            ai_decision: "discard",
            ai_reason: "System Discard: Exceeded max batch token limit",
          },
        }),
        prisma.processedFile.update({
          where: { id: fileId },
          data: { ai_discarded_count: { increment: 1 } },
        }),
      ]);

      continue;
    }

    if (currentTokenCount + estimatedTokens > maxTokensPerBatch) {
      console.log(
        `[AI Chunking] Reached safety limit (${currentTokenCount}/${maxTokensPerBatch} tokens). Splitting batch...`,
      );
      break;
    }

    const request = {
      custom_id: hash,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: MODEL_NAME,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0,
        max_completion_tokens: 150,
        response_format: RESPONSE_FORMAT,
      },
    };

    writer.write(`${JSON.stringify(request)}\n`);
    currentTokenCount += estimatedTokens;
    addedCount++;
  }

  writer.end();
  await new Promise<void>((resolve) => writer.on("finish", () => resolve()));

  if (addedCount === 0) {
    const totalAiMs =
      typeof row.ai_started_at === "bigint"
        ? Math.max(0, Date.now() - Number(row.ai_started_at))
        : 0;
    await markCaseAiCompleted(fileId, totalAiMs);
    if (fs.existsSync(batchFilePath)) fs.unlinkSync(batchFilePath);
    return;
  }

  console.log(
    `[AI Engine] Uploading Chunk of ${addedCount} items (~${currentTokenCount} tokens) to OpenAI...`,
  );

  const fileUpload = await openai.files.create({
    file: fs.createReadStream(batchFilePath),
    purpose: "batch",
  });

  const batch = await openai.batches.create({
    input_file_id: fileUpload.id,
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });

  await prisma.processedFile.update({
    where: { id: fileId },
    data: { batch_id: batch.id, ai_status: "batch_ready" },
  });
}
