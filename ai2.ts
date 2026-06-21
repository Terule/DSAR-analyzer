import fs from "node:fs";
import path from "node:path";
import { db } from "./db";

interface DecisionResponse {
  decisions: Array<{
    id: string;
    decision: "keep" | "discard";
    reason: string;
  }>;
}

interface FileDecisionResponse {
  decision: "keep" | "discard";
  reason: string;
}

interface EmailPayload {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  attachments?: boolean;
  body?: string;
}

interface ExtractedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * Implements exponential backoff for the OpenAI API call.
 */
async function callChatCompletionWithRetry(
  payload: string,
  apiKey: string,
): Promise<Response> {
  const url = "https://api.openai.com/v1/chat/completions";
  const retries = 10;
  let baseDelay = 4000;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: payload,
      });

      if (response.ok) return response;

      if (response.status === 429 || response.status >= 500) {
        if (attempt === retries)
          throw new Error(
            `HTTP Error: ${response.status} ${response.statusText}`,
          );

        let delay = baseDelay;
        if (response.status === 429) {
          try {
            const errorData = await response.clone().json();
            const match = errorData?.error?.message?.match(
              /try again in (\d+)(m?s)/,
            );
            if (match) {
              const amount = parseInt(match[1], 10);
              const unit = match[2];
              delay = (unit === "s" ? amount * 1000 : amount) + 1000;
            } else {
              const retryAfter = response.headers.get("retry-after");
              if (retryAfter) delay = parseInt(retryAfter, 10) * 1000;
            }
          } catch (_e) {}
        }

        console.warn(
          `[API Limit Hit] Waiting ${delay}ms before retry ${attempt + 1}/${retries}...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        baseDelay = Math.min(baseDelay * 2, 60000);
        continue;
      }

      throw new Error(
        `HTTP Terminal Error: ${response.status} ${response.statusText}`,
      );
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelay));
      baseDelay = Math.min(baseDelay * 2, 60000);
    }
  }
  throw new Error(
    "Failed to communicate with OpenAI API after maximum retries.",
  );
}

function extractAttachmentsFromEml(emlContent: string): ExtractedAttachment[] {
  const attachments: ExtractedAttachment[] = [];
  const lines = emlContent.split("\n");
  let boundary = "";

  for (const line of lines) {
    if (line.toLowerCase().includes("boundary=")) {
      const match = line.match(/boundary=["']?([^"']+)["']?/i);
      if (match) {
        boundary = match[1];
        break;
      }
    }
  }

  if (!boundary) return attachments;

  const parts = emlContent.split(`--${boundary}`);
  for (const part of parts) {
    if (
      part.includes("Content-Disposition: attachment") ||
      part.includes("Content-Disposition: inline;")
    ) {
      const dispositionLine = part
        .split("\n")
        .find((l) => l.toLowerCase().includes("filename="));
      const fileMatch = dispositionLine?.match(
        /filename=["']?([^"'\s]+)["']?/i,
      );
      const filename = fileMatch ? fileMatch[1] : `attachment_${Date.now()}`;

      const contentTypeLine = part
        .split("\n")
        .find((l) => l.toLowerCase().includes("content-type:"));
      const contentTypeMatch = contentTypeLine?.match(
        /content-type:\s*([^;\s]+)/i,
      );
      const contentType = contentTypeMatch
        ? contentTypeMatch[1]
        : "application/octet-stream";

      const headerBodySplit = part.split(/\r?\n\r?\n/);
      if (headerBodySplit.length > 1) {
        const rawBody = headerBodySplit.slice(1).join("\n\n").trim();
        const base64Clean = rawBody.replace(/[\r\n\s]+/g, "");
        const buffer = Buffer.from(base64Clean, "base64");

        attachments.push({ filename, contentType, content: buffer });
      }
    }
  }

  return attachments;
}

/**
 * Cleans up Excel/CSV files, saves the native file, and returns the filtered text
 * so it can be independently converted to a PDF representation.
 */
async function pruneSpreadsheet(
  filePath: string,
  criteria: { name: string; email: string; aliases: string[] },
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  let filteredTextOutput = "";

  if (ext === ".csv") {
    const rawText = fs.readFileSync(filePath, "utf-8");
    const lines = rawText.split("\n");
    const header = lines[0];
    const filteredLines = [header];

    const matchTerms = [
      criteria.name.toLowerCase(),
      criteria.email.toLowerCase(),
      ...criteria.aliases.map((a) => a.toLowerCase()),
    ];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const lineLower = line.toLowerCase();
      const match = matchTerms.some((term) => lineLower.includes(term));
      if (match) filteredLines.push(line);
    }

    filteredTextOutput = filteredLines.join("\n");
    fs.writeFileSync(filePath, filteredTextOutput);
  } else {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.readFile(filePath);
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      const rows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
      }) as string[][];
      const matchTerms = [
        criteria.name.toLowerCase(),
        criteria.email.toLowerCase(),
        ...criteria.aliases.map((a) => a.toLowerCase()),
      ];

      const header = rows[0] || [];
      const filteredRows = [header];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const rowString = row
          .map((cell) => String(cell || ""))
          .join(" ")
          .toLowerCase();
        const matches = matchTerms.some((term) => rowString.includes(term));
        if (matches) filteredRows.push(row);
      }

      filteredTextOutput = filteredRows.map((r) => r.join(" | ")).join("\n");
      const newWorksheet = XLSX.utils.aoa_to_sheet(filteredRows);
      workbook.Sheets[firstSheetName] = newWorksheet;
      XLSX.writeFile(workbook, filePath);
    } catch (e) {
      console.warn(
        `Spreadsheet library warning for binary file ${path.basename(filePath)}. Falling back.`,
        e,
      );
      filteredTextOutput =
        "Binary spreadsheet filtering failed. Native file retained.";
    }
  }

  return filteredTextOutput;
}

/**
 * Standardizes text content and exports it cleanly as a standard PDF.
 */
async function convertTextToMockPdf(
  textContent: string,
  targetPdfPath: string,
): Promise<void> {
  const pdfMockHeader = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n5 0 obj\n<< /Length ${textContent.length + 50} >>\nstream\nBT\n/F1 12 Tf\n50 750 Td\n15 TL\n`;
  const pdfMockFooter = `\nET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f\n0000000009 00000 n\n0000000056 00000 n\n0000000111 00000 n\n0000000212 00000 n\n0000000303 00000 n\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n353\n%%EOF`;

  const sanitizedText = textContent
    .replace(/[()]/g, "\\$&")
    .split("\n")
    .map((line) => `(${line.substring(0, 100)}) Tj T*`)
    .join("\n");

  fs.writeFileSync(
    targetPdfPath,
    pdfMockHeader + sanitizedText + pdfMockFooter,
  );
}

async function assessAttachmentWithAI(
  filename: string,
  previewText: string,
  subjectCriteria: { name: string; email: string; aliases: string[] },
  apiKey: string,
): Promise<boolean> {
  const systemPrompt = `You are a strict eDiscovery auditing compliance AI. Assess if the attached file contains relevant information for a Data Subject Request (DSAR).
Target Data Subject:
- Name: ${subjectCriteria.name}
- Email: ${subjectCriteria.email}
- Aliases: ${subjectCriteria.aliases.join(", ")}

CRITERIA TO "keep" (Must meet at least one):
1. If the attachment is an email (.eml/.msg), keep it ONLY IF the Data Subject is the sender, OR if it's a direct reply/forward of the subject's email (if it is part of a chain, keep ONLY the OLDEST/FIRST forward or reply that started the chain, discarding newer subsequent replies).
2. If the attachment is a document/spreadsheet, keep it if it contains highly specific references to the Data Subject's actions.

CRITERIA TO "discard" (If ANY match, you MUST discard):
1. The file name or preview contains any of these words: "Confidentiality ring", "confidential", or "privileged" (case-insensitive).
2. It's a generic file, system logo, or irrelevant attachment that does not strictly involve the subject.

Your response MUST be a single JSON object strictly matching this schema:
{
  "decision": "keep" | "discard",
  "reason": "1-sentence reason"
}`;

  const userPrompt = `Evaluate this attached file metadata:
Filename: ${filename}
Preview (first 1000 chars): ${previewText.substring(0, 1000)}`;

  const apiPayload = JSON.stringify({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  try {
    const response = await callChatCompletionWithRetry(apiPayload, apiKey);
    const data = await response.json();
    const gptContentStr = data.choices?.[0]?.message?.content;
    if (!gptContentStr) return false;

    const result = JSON.parse(gptContentStr) as FileDecisionResponse;
    return result.decision === "keep";
  } catch (error) {
    console.error(`AI Attachment evaluation failed for ${filename}:`, error);
    return false;
  }
}

/**
 * Recursively parses and extracts nested attachments, processing nested .eml/.msg structures
 * all the way down, and enforcing strict Bates numbering conventions.
 */
async function processAttachmentsRecursively(
  emlFilePath: string,
  approvedDir: string,
  criteria: { name: string; email: string; aliases: string[] },
  apiKey: string,
  nestedDepth: number,
  parentName: string,
): Promise<void> {
  if (nestedDepth > 10) return;

  const emlContent = fs.readFileSync(emlFilePath, "utf-8");
  const attachments = extractAttachmentsFromEml(emlContent);

  // Dynamic padding based on the number of attachments found in this specific email
  const attPadding = Math.max(3, attachments.length.toString().length);

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const ext = path.extname(attachment.filename).toLowerCase() || ".dat";

    // Naming Convention Rule: Email 0001 Attachment 001
    const attNumber = String(i + 1).padStart(attPadding, "0");
    const attachmentName = `${parentName} Attachment ${attNumber}`;
    const isEmail = ext === ".eml" || ext === ".msg";

    if (isEmail) {
      const emailData: EmailPayload = {
        subject: `Attachment Email: ${attachment.filename}`,
        body: attachment.content.toString("utf-8").substring(0, 5000),
      };

      const shouldKeep = await assessAttachmentWithAI(
        attachment.filename,
        emailData.body || "",
        criteria,
        apiKey,
      );
      await new Promise((resolve) => setTimeout(resolve, 8000));

      if (shouldKeep) {
        const childEmlPath = path.join(approvedDir, `${attachmentName}.eml`);
        const childJsonPath = path.join(approvedDir, `${attachmentName}.json`);

        fs.writeFileSync(childJsonPath, JSON.stringify(emailData));
        fs.writeFileSync(childEmlPath, attachment.content);

        // Recurse deeper (e.g., Email 0001 Attachment 001 Attachment 001)
        await processAttachmentsRecursively(
          childEmlPath,
          approvedDir,
          criteria,
          apiKey,
          nestedDepth + 1,
          attachmentName,
        );
      }
    } else {
      const previewText = attachment.content
        .toString("utf-8")
        .substring(0, 1000);
      const shouldKeep = await assessAttachmentWithAI(
        attachment.filename,
        previewText,
        criteria,
        apiKey,
      );
      await new Promise((resolve) => setTimeout(resolve, 8000));

      if (shouldKeep) {
        const outFilePath = path.join(approvedDir, `${attachmentName}${ext}`);

        // Save the file under its new sequential name (e.g., Email 0001 Attachment 001.pdf or .xlsx)
        fs.writeFileSync(outFilePath, attachment.content);

        // Process special formats
        if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
          // Prune the native file AND extract the filtered text
          const filteredText = await pruneSpreadsheet(outFilePath, criteria);
          // Convert the filtered text directly to a PDF side-by-side with Bates name
          const targetPdf = path.join(approvedDir, `${attachmentName}.pdf`);
          await convertTextToMockPdf(filteredText, targetPdf);
        }
      }
    }
  }
}

/**
 * Step 5 AI Evaluation: Unified Folder Processing
 * Audits emails, renames to sequential convention across split PSTs,
 * deletes unused files, and handles recursive attachments.
 */
export async function evaluateEmailsWithAI(
  fileId: string,
  subjectCriteria: { name: string; email: string; aliases: string[] },
  outputBaseDir: string = process.env.EXTRACTED_PATH ||
    "/Users/rgomes/Projects/extracted_emails",
  batchSize: number = 1,
) {
  try {
    db.exec(`
      ALTER TABLE processed_files ADD COLUMN ai_status TEXT DEFAULT 'pending';
      ALTER TABLE processed_files ADD COLUMN ai_approved_count INTEGER DEFAULT 0;
      ALTER TABLE processed_files ADD COLUMN ai_discarded_count INTEGER DEFAULT 0;
    `);
  } catch (_e) {}

  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
  if (!row)
    throw new Error(`Target file not found for AI evaluation: ${fileId}`);

  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey)
    throw new Error("Missing OPENAI_API_KEY inside environment variables.");

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  let relativeSystemPath = path.relative(stagingPath, row.filepath);
  if (
    relativeSystemPath.startsWith("..") ||
    path.isAbsolute(relativeSystemPath)
  ) {
    relativeSystemPath = fileId;
  }

  // UNIFIED FOLDER LOGIC: Output to the directory containing the PST, not an isolated subfolder per PST
  let cleanRelativePath = path.dirname(relativeSystemPath);
  if (cleanRelativePath === "." || cleanRelativePath === "") {
    cleanRelativePath = path.parse(relativeSystemPath).name;
  }
  const targetFolder = path.join(outputBaseDir, cleanRelativePath);

  if (!fs.existsSync(targetFolder))
    throw new Error(
      `No extracted unified folder found for processing: ${targetFolder}`,
    );

  db.prepare(
    "UPDATE processed_files SET ai_status = 'processing', ai_approved_count = 0, ai_discarded_count = 0 WHERE id = ?",
  ).run(fileId);

  const approvedDir = path.join(targetFolder, "approved");
  if (!fs.existsSync(approvedDir))
    fs.mkdirSync(approvedDir, { recursive: true });

  (async () => {
    try {
      const allFiles = fs
        .readdirSync(targetFolder)
        .filter((file) => file.endsWith(".json"))
        .map((file) => ({
          filename: file,
          hash: file.replace(".json", ""),
          filePath: path.join(targetFolder, file),
        }));

      let approvedCounter = 0;
      let discardedCounter = 0;

      // Dynamic padding for up to 9999 emails standard
      const emailPadding = 4;

      // BATES CONTINUATION LOGIC: Scan the unified folder for the highest previously numbered email.
      // This guarantees that 002.pst continues numbering where 001.pst left off.
      let existingMax = 0;
      if (fs.existsSync(approvedDir)) {
        const existingFiles = fs.readdirSync(approvedDir);
        for (const f of existingFiles) {
          const match = f.match(/^Email (\d+)/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > existingMax) existingMax = num;
          }
        }
      }

      let approvedEmailCounter = existingMax + 1;

      // NEGATIVE CONSTRAINTS ADDED TO SYSTEM PROMPT
      const systemPrompt = `You are a strict legal compliance AI performing a Data Subject Access Request (DSAR) audit.
You are evaluating a batch of emails.
Target Data Subject Info:
- Name: ${subjectCriteria.name}
- Email: ${subjectCriteria.email}
- Known Aliases: ${subjectCriteria.aliases.join(", ")}

CRITERIA TO "keep" (Must meet at least one):
1. The Data Subject is the direct sender of the email.
2. The email is a direct response (reply) to an email sent by the Data Subject.
3. The email forwards a message originally sent by the Data Subject.
4. If it is an email chain involving the subject's message, select ONLY the OLDEST/FIRST email that originated the subsequent discussion (e.g., if Subject sends to John, John forwards to Ellie/Frank, and they reply back and forth multiple times, keep ONLY the initial email where John forwarded it to Ellie/Frank). Discard all subsequent newer replies in that chain.

CRITERIA TO "discard" (If ANY match, you MUST discard):
1. The email subject line or body explicitly contains the exact phrases: "Confidentiality ring", "confidential", or "privileged" (case-insensitive).
2. The email does not meet the "keep" criteria above.
3. The email is a generic company-wide announcement, system alert, or spam where the subject is merely CC'd.

Your response MUST be a single JSON object strictly matching this schema:
{
  "decisions": [
    { "id": "email_hash_string", "decision": "keep" | "discard", "reason": "Short 1-sentence legal justification based on the strict criteria" }
  ]
}`;

      for (let i = 0; i < allFiles.length; i += batchSize) {
        const chunk = allFiles.slice(i, i + batchSize);
        const batchEmailsPayload: Record<string, EmailPayload> = {};

        for (const fileObj of chunk) {
          try {
            const rawContent = fs.readFileSync(fileObj.filePath, "utf-8");
            batchEmailsPayload[fileObj.hash] = JSON.parse(
              rawContent,
            ) as EmailPayload;
          } catch (_err) {}
        }

        const userPrompt = `Evaluate this batch of emails and respond with the structured JSON format: \n\n${JSON.stringify(batchEmailsPayload)}`;

        const apiPayload = JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });

        const response = await callChatCompletionWithRetry(apiPayload, apiKey);
        const rawJsonData = await response.json();

        const gptContentStr = rawJsonData.choices?.[0]?.message?.content;
        if (!gptContentStr)
          throw new Error(
            "OpenAI completed successfully but returned an empty response body.",
          );

        const decisionResult = JSON.parse(gptContentStr) as DecisionResponse;

        for (const dec of decisionResult.decisions) {
          const matchedFile = chunk.find((f) => f.hash === dec.id);
          if (!matchedFile) continue;

          const jsonSource = matchedFile.filePath;
          const emlSource = path.join(targetFolder, `${dec.id}.eml`);

          if (dec.decision === "keep") {
            approvedCounter++;

            // Generate Bates String: Email 0001
            const emailName = `Email ${String(approvedEmailCounter).padStart(emailPadding, "0")}`;
            const approvedEmlPath = path.join(approvedDir, `${emailName}.eml`);
            const approvedJsonPath = path.join(
              approvedDir,
              `${emailName}.json`,
            );

            // Move and rename
            if (fs.existsSync(jsonSource))
              fs.renameSync(jsonSource, approvedJsonPath);
            if (fs.existsSync(emlSource))
              fs.renameSync(emlSource, approvedEmlPath);

            // Extract attachments with parent name injection
            await processAttachmentsRecursively(
              approvedEmlPath,
              approvedDir,
              subjectCriteria,
              apiKey,
              0,
              emailName,
            );

            approvedEmailCounter++;
          } else {
            discardedCounter++;
            if (fs.existsSync(jsonSource)) fs.unlinkSync(jsonSource);
            if (fs.existsSync(emlSource)) fs.unlinkSync(emlSource);
          }
        }

        db.prepare(`
          UPDATE processed_files 
          SET ai_approved_count = ?, ai_discarded_count = ?
          WHERE id = ?
        `).run(approvedCounter, discardedCounter, fileId);

        await new Promise((resolve) => setTimeout(resolve, 12000));
      }

      db.prepare(
        "UPDATE processed_files SET ai_status = 'completed' WHERE id = ?",
      ).run(fileId);
    } catch (error) {
      console.error(`AI Filter processing engine failed on ${fileId}:`, error);
      db.prepare(
        "UPDATE processed_files SET ai_status = 'failed' WHERE id = ?",
      ).run(fileId);
    }
  })().catch((err) => console.error("Unhandled async AI thread error:", err));
}
