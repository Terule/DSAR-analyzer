import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PSTFile, type PSTFolder, type PSTMessage } from "pst-extractor";
import { db } from "./db";

/**
 * Extracts and cleans the body of the email.
 * Fallbacks to HTML body if plain text is missing, and strips HTML tags.
 */
function extractBodyText(email: PSTMessage): string {
  const emailWithHtml = email as unknown as { bodyHTML?: string };
  let text = email.body || emailWithHtml.bodyHTML || "";

  // If it looks like HTML, strip the tags to keep it clean for the LLM
  if (text.includes("<") && text.includes(">")) {
    text = text
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ") // Remove CSS
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ") // Remove JS
      .replace(/<[^>]+>/g, " "); // Remove HTML tags
  }

  // Always remove HTML entities (like &nbsp;, &#8203;), even if tags weren't detected
  text = text.replace(/&[a-zA-Z0-9#]+;/g, " ");

  return text;
}

/**
 * Cleans up email body text to save LLM tokens.
 * Removes multiple spaces and reduces continuous line breaks.
 */
function optimizeTokens(text: string): string {
  if (!text) return "";
  return text
    .replace(/\r\n/g, "\n") // Normalize line breaks
    .replace(/ {2,}/g, " ") // Remove double spaces
    .replace(/(?:\n\s*){3,}/g, "\n\n") // Collapse 3+ line breaks into 2
    .trim();
}

/**
 * Step 1: Extract unique emails from the PST to a structured local directory
 * mimicking the staging area system folder structure.
 */
export async function extractUniqueEmails(
  fileId: string,
  outputBaseDir: string = "/Users/rafaelaguiar/Projects/extracted_emails",
) {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;

  if (!row || !fs.existsSync(row.filepath)) {
    throw new Error(`File target missing for extraction: ${fileId}`);
  }

  // Auto-migrate the database to include the new estimated_tokens column if it doesn't exist
  try {
    db.prepare(
      "ALTER TABLE processed_files ADD COLUMN estimated_tokens INTEGER DEFAULT 0",
    ).run();
  } catch (_error) {
    // Column likely already exists, safe to ignore
  }

  // Update status so the UI knows we are extracting, and reset token count
  db.prepare(
    "UPDATE processed_files SET status = 'extracting', estimated_tokens = 0 WHERE id = ?",
  ).run(fileId);

  (async () => {
    try {
      const stagingPath =
        process.env.STAGING_PATH || "/Users/rafaelaguiar/Projects/staging-area";
      let relativeSystemPath = path.relative(stagingPath, row.filepath);

      if (
        relativeSystemPath.startsWith("..") ||
        path.isAbsolute(relativeSystemPath)
      ) {
        relativeSystemPath = fileId;
      }

      const cleanRelativePath = relativeSystemPath.replace(/\.pst$/i, "");
      const exportRoot = path.join(outputBaseDir, cleanRelativePath);

      if (!fs.existsSync(exportRoot)) {
        fs.mkdirSync(exportRoot, { recursive: true });
      }

      const uniqueHashes = new Set(
        db
          .prepare(
            "SELECT email_hash FROM emails WHERE file_id = ? AND is_duplicate = 0",
          )
          .all(fileId)
          .map((r: unknown) => (r as { email_hash: string }).email_hash),
      );

      const pstFile = new PSTFile(row.filepath);
      const rootFolder = pstFile.getRootFolder();

      let totalTokensEstimate = 0;
      let processedSinceLastUpdate = 0;

      async function traverseAndExtract(folder: PSTFolder) {
        if (folder.contentCount > 0) {
          let email: PSTMessage | null = folder.getNextChild();

          while (email !== null) {
            const messageId = email.internetMessageId?.trim() || "";
            const sentDate = email.clientSubmitTime
              ? email.clientSubmitTime.toISOString()
              : "";
            const subject = email.subject?.trim() || "";
            const rawBody = extractBodyText(email);

            let emailHash = "";
            if (messageId && messageId.length > 5) {
              emailHash = crypto
                .createHash("sha256")
                .update(messageId)
                .digest("hex");
            } else {
              emailHash = crypto
                .createHash("sha256")
                .update(
                  `${subject || "no-subject"}_${sentDate || "no-date"}_${rawBody.substring(0, 500)}`,
                )
                .digest("hex");
            }

            if (uniqueHashes.has(emailHash)) {
              const emailData: Record<string, string | boolean> = {};

              const sender = email.senderName || email.senderEmailAddress;
              if (sender) emailData.from = sender.trim();
              if (email.displayTo) emailData.to = email.displayTo.trim();
              if (subject) emailData.subject = subject;
              if (sentDate) emailData.date = sentDate;
              if (email.hasAttachments) emailData.attachments = true;

              const cleanBody = optimizeTokens(rawBody);
              if (cleanBody) emailData.body = cleanBody;

              const jsonString = JSON.stringify(emailData);
              const outPath = path.join(exportRoot, `${emailHash}.json`);
              fs.writeFileSync(outPath, jsonString);

              // Rule of thumb: 1 token ≈ 4 characters in English text
              const tokensInThisEmail = Math.ceil(jsonString.length / 4);
              totalTokensEstimate += tokensInThisEmail;
              processedSinceLastUpdate++;

              // Update the UI with token count every 50 emails
              if (processedSinceLastUpdate >= 50) {
                db.prepare(
                  "UPDATE processed_files SET estimated_tokens = ? WHERE id = ?",
                ).run(totalTokensEstimate, fileId);
                processedSinceLastUpdate = 0;
              }

              await new Promise((res) => setTimeout(res, 0));
            }
            email = folder.getNextChild();
          }
        }

        if (folder.hasSubfolders) {
          for (const sub of folder.getSubFolders()) {
            await traverseAndExtract(sub);
          }
        }
      }

      await traverseAndExtract(rootFolder);

      // Final update with complete token count
      db.prepare(
        "UPDATE processed_files SET status = 'completed', estimated_tokens = ? WHERE id = ?",
      ).run(totalTokensEstimate, fileId);
    } catch (error) {
      console.error(`Extraction failed on file ${fileId}:`, error);
      db.prepare(
        "UPDATE processed_files SET status = 'failed' WHERE id = ?",
      ).run(fileId);
    }
  })().catch((err) =>
    console.error("Unhandled async extraction thread error:", err),
  );
}
