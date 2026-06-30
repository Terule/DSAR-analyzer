import fs from "node:fs";
import path from "node:path";
import { encodingForModel } from "js-tiktoken";
import OpenAI from "openai";
import { db } from "./db";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL_NAME = "gpt-4o-mini";
const TOKENIZER = encodingForModel(MODEL_NAME);

// Enforce max enqueued rate headroom
const MAX_TOKENS_PER_BATCH = 900_000;
const MAX_COMPLETION_TOKENS_PER_REQUEST = 150;
const CHAT_MESSAGE_OVERHEAD_TOKENS = 12;
const REQUEST_OVERHEAD_TOKENS = 24;
const DISCARD_SUBJECT_RE =
  /(?<![A-Za-z0-9])(Confidential|Confidentiality|Privileged|CROs?)(?![A-Za-z0-9])/i;
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

function estimateRequestTokens(
  systemPrompt: string,
  userContent: string,
): number {
  return (
    countTokens(systemPrompt) +
    countTokens(userContent) +
    countTokens(JSON.stringify(RESPONSE_FORMAT)) +
    CHAT_MESSAGE_OVERHEAD_TOKENS +
    REQUEST_OVERHEAD_TOKENS +
    MAX_COMPLETION_TOKENS_PER_REQUEST
  );
}

export async function generateBatchFile(
  fileId: string,
  subjectCriteria: { name: string; email: string; aliases: string[] },
) {
  const row = db
    .prepare("SELECT filepath, ai_started_at FROM processed_files WHERE id = ?")
    .get(fileId) as
    | { filepath: string; ai_started_at?: number | null }
    | undefined;
  if (!row) throw new Error("File not found");

  // Save criteria configuration securely to disk
  db.prepare(`
    UPDATE processed_files 
    SET subject_name = ?, subject_email = ?, subject_aliases = ? 
    WHERE id = ?
  `).run(
    subjectCriteria.name,
    subjectCriteria.email,
    subjectCriteria.aliases.join(", "),
    fileId,
  );

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  const extractedPath =
    process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";

  let relativeSystemPath = path.relative(stagingPath, row.filepath);
  if (
    relativeSystemPath.startsWith("..") ||
    path.isAbsolute(relativeSystemPath)
  ) {
    relativeSystemPath = fileId;
  }

  let cleanRelativePath = path.dirname(relativeSystemPath);
  if (cleanRelativePath === "." || cleanRelativePath === "") {
    cleanRelativePath = path.parse(relativeSystemPath).name;
  }

  const targetFolder = path.join(extractedPath, cleanRelativePath);
  const uniqueEmailsFolder = path.join(targetFolder, ".unique-emails");
  const jsonFolder = path.join(uniqueEmailsFolder, "json-files");
  if (!fs.existsSync(targetFolder))
    throw new Error("Extracted folder not found");
  if (!fs.existsSync(jsonFolder))
    throw new Error("JSON folder not found in .unique-emails/json-files");

  const batchDir = path.join(process.cwd(), "batches");
  if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true });

  const allFiles = fs
    .readdirSync(jsonFolder)
    .filter((f) => f.endsWith(".json"));

  const unprocessedRecords = db
    .prepare(`
    SELECT email_hash FROM emails 
    WHERE file_id = ? AND is_duplicate = 0 AND ai_decision IS NULL
  `)
    .all(fileId) as { email_hash: string }[];

  const unprocessedHashes = new Set(
    unprocessedRecords.map((r) => r.email_hash),
  );

  const systemPrompt = `You are an expert Legal AI performing a Data Subject Access Request (DSAR) compliance audit.
Target Data Subject: ${subjectCriteria.name}
Target Email: ${subjectCriteria.email}
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
- Subject's exact email appears in first_email.from.
- Subject's exact email appears in first_email.to AND first_email has only one recipient.
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

    // Pre-filter: Rule 1 — subject-based immediate discard (no AI needed)
    const subject: string = content?.first_email?.subject ?? "";
    if (DISCARD_SUBJECT_RE.test(subject)) {
      db.prepare(
        "UPDATE emails SET ai_decision = 'discard', ai_reason = 'Pre-filter: Subject contains privileged/confidential keyword' WHERE email_hash = ? AND file_id = ?",
      ).run(hash, fileId);
      db.prepare(
        "UPDATE processed_files SET ai_discarded_count = ai_discarded_count + 1 WHERE id = ?",
      ).run(fileId);
      continue;
    }

    const userContent = JSON.stringify(content);
    const estimatedTokens = estimateRequestTokens(systemPrompt, userContent);

    if (estimatedTokens > MAX_TOKENS_PER_BATCH) {
      console.log(
        `[AI Engine] Warning: Email ${hash} exceeds max tokens on its own (${estimatedTokens} tokens). Discarding...`,
      );

      // 🚨 CRITICAL FIX: Ensure skipped oversized files are marked as discarded so they don't infinite-loop!
      db.prepare(
        "UPDATE emails SET ai_decision = 'discard', ai_reason = 'System Discard: Exceeded max batch token limit' WHERE email_hash = ? AND file_id = ?",
      ).run(hash, fileId);

      db.prepare(
        "UPDATE processed_files SET ai_discarded_count = ai_discarded_count + 1 WHERE id = ?",
      ).run(fileId);

      continue;
    }

    if (currentTokenCount + estimatedTokens > MAX_TOKENS_PER_BATCH) {
      console.log(
        `[AI Chunking] Reached safety limit (${currentTokenCount} tokens). Splitting batch...`,
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
      typeof row.ai_started_at === "number"
        ? Math.max(0, Date.now() - row.ai_started_at)
        : 0;
    db.prepare(
      "UPDATE processed_files SET ai_status = 'completed', batch_id = NULL, ai_duration_ms = ?, ai_started_at = NULL WHERE id = ?",
    ).run(totalAiMs, fileId);
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

  db.prepare(
    "UPDATE processed_files SET batch_id = ?, ai_status = 'batch_ready' WHERE id = ?",
  ).run(batch.id, fileId);
}
