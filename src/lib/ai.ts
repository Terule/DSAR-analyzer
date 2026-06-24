import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { db } from "./db";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Enforce max enqueued rate headroom
const MAX_TOKENS_PER_BATCH = 900_000;
const MAX_COMPLETION_TOKENS_PER_REQUEST = 150;

export async function generateBatchFile(
  fileId: string,
  subjectCriteria: { name: string; email: string; aliases: string[] },
) {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
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
  if (!fs.existsSync(targetFolder))
    throw new Error("Extracted folder not found");

  const batchDir = path.join(process.cwd(), "batches");
  if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true });

  const allFiles = fs
    .readdirSync(targetFolder)
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

  // STEP 4 UPDATE: The prompt now perfectly matches the new Flat JSON payload format.
  // We removed references to ignoring database keys since they are no longer in the payload.
  const systemPrompt = `You are an expert Legal AI performing a Data Subject Access Request (DSAR) compliance audit.
Target Data Subject: ${subjectCriteria.name}
Target Email: ${subjectCriteria.email}
Aliases: ${subjectCriteria.aliases.join(", ")}

INSTRUCTIONS:
You are receiving a flat text document containing an email's headers (Date, From, To, Subject) followed by its body text. Evaluate it using this strict reasoning sequence:

1. [HEADER CHECK] Does the subject line contain "Confidential", "CRO", "CROs", or "Confidentiality ring"?
   - If Yes -> "discard" immediately.
2. [HEADER CHECK] Was it sent by the subject? 
   - If Yes -> "keep".
3. [HEADER CHECK] Was it sent directly to the subject (excluding CC/BCC)? 
   - If Yes -> "keep".
4. [BODY CHECK] Is the name of the subject mentioned in the email body?
   - If Yes -> "keep".
5. [BODY CHECK] Is it forwarding a subject email directly? 
   - If Yes -> "keep".
6. Reject everything else.
   - If none of the above are true -> "discard".

OUTPUT FORMAT: You must return ONLY a raw JSON object. Do not wrap the output in markdown code blocks (\`\`\`json). Do not add conversational text.
Format exactly like this: {"decision": "keep" | "discard", "reason": "Brief justification."}`;

  const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
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

    const filePath = path.join(targetFolder, file);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8")); // Now reads { text: "..." }

    const userPromptTokens = Math.ceil(JSON.stringify(content).length / 4);
    const estimatedTokens =
      systemPromptTokens + userPromptTokens + MAX_COMPLETION_TOKENS_PER_REQUEST;

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
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(content) },
        ],
        temperature: 0.0,
        max_completion_tokens: 150,
      },
    };

    writer.write(`${JSON.stringify(request)}\n`);
    currentTokenCount += estimatedTokens;
    addedCount++;
  }

  writer.end();
  await new Promise<void>((resolve) => writer.on("finish", () => resolve()));

  if (addedCount === 0) {
    db.prepare(
      "UPDATE processed_files SET ai_status = 'completed' WHERE id = ?",
    ).run(fileId);
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
