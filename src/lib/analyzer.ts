import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PSTFile, type PSTFolder, type PSTMessage } from "pst-extractor";
import { db } from "./db";

interface AnalysisMetrics {
  uniqueCount: number;
  duplicateCount: number;
  totalProcessed: number;
  totalAttachments: number;
}

function safeGetSubFolders(folder: PSTFolder): PSTFolder[] {
  try {
    const sub = folder.getSubFolders();
    return sub && Array.isArray(sub) ? sub : [];
  } catch (err: unknown) {
    console.warn(`[PST BTree Warning] Bypassed corrupted child folders:`, err);
    return [];
  }
}

function isSystemOrSearchFolder(folderName: string): boolean {
  if (!folderName) return false;
  const name = folderName.toLowerCase();
  return (
    name.includes("spam search folder") ||
    name.includes("search folder") ||
    name.includes("finder") ||
    name.includes("common views") ||
    name.includes("deferred action") ||
    name.includes("top of outlook data file") ||
    name === "views" ||
    name === "allpublicfolders"
  );
}

// Smarter Fallback Generator (Ignored 'To' field and first 20 body chars)
function generateFallbackHash(
  senderRaw: string,
  subjectRaw: string,
  bodyRaw: string,
): string {
  const sender = senderRaw.toLowerCase().replace(/[^a-z0-9]/g, "");
  const subject = subjectRaw
    .toLowerCase()
    .replace(/^(re|fw|fwd|wg|aw)\s*:\s*/g, "")
    .replace(/[^a-z0-9]/g, "");
  const body = bodyRaw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .substring(20, 120);

  return crypto
    .createHash("sha256")
    .update(`${sender}_${subject}_${body}`)
    .digest("hex");
}

export async function scanFileMetadata(fileId: string): Promise<void> {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
  if (!row)
    throw new Error(`File record not found in database for ID: ${fileId}`);

  let totalEmails = 0;

  try {
    const pst = new PSTFile(row.filepath);
    const rootFolder = pst.getRootFolder();

    async function traverse(folder: PSTFolder, isRoot = false) {
      const displayName = folder.displayName || "";
      if (!isRoot && isSystemOrSearchFolder(displayName)) return;

      totalEmails += folder.contentCount;
      const subFolders = safeGetSubFolders(folder);
      if (subFolders.length > 0) {
        for (const sub of subFolders) await traverse(sub, false);
      }
    }

    await traverse(rootFolder, true);

    db.prepare(`
      UPDATE processed_files 
      SET total_emails = ?, total_attachments = 0, status = 'pending_analysis'
      WHERE id = ?
    `).run(totalEmails, fileId);
  } catch (error: unknown) {
    console.error(`Metadata scanning failed on file ${fileId}:`, error);
    db.prepare("UPDATE processed_files SET status = 'failed' WHERE id = ?").run(
      fileId,
    );
    throw error;
  }
}

// Recursive EML builder to embed attachments natively
function buildRawEml(
  emailObj: PSTMessage,
  messageId: string,
  sentDate: string,
  subject: string,
): string {
  const boundaryMix = `----=_MixedBoundary_${crypto.randomBytes(8).toString("hex")}`;
  const boundaryAlt = `----=_AltBoundary_${crypto.randomBytes(8).toString("hex")}`;

  const plainText = emailObj.body || "";
  const htmlText = emailObj.bodyHTML || "";
  const senderRaw =
    emailObj.senderName || emailObj.senderEmailAddress || "Unknown";
  const toRaw = emailObj.displayTo || "Unknown";

  let emlContent = `Message-ID: <${messageId}>\r\nDate: ${sentDate}\r\nFrom: ${senderRaw}\r\nTo: ${toRaw}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\n`;

  if (emailObj.hasAttachments) {
    emlContent += `Content-Type: multipart/mixed; boundary="${boundaryMix}"\r\n\r\n--${boundaryMix}\r\n`;
  }

  if (htmlText) {
    emlContent += `Content-Type: multipart/alternative; boundary="${boundaryAlt}"\r\n\r\n`;
    if (plainText) {
      emlContent += `--${boundaryAlt}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plainText}\r\n\r\n`;
    }
    emlContent += `--${boundaryAlt}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${htmlText}\r\n\r\n--${boundaryAlt}--\r\n\r\n`;
  } else {
    emlContent += `Content-Type: text/plain; charset=utf-8\r\n\r\n${plainText}\r\n\r\n`;
  }

  if (emailObj.hasAttachments) {
    for (let i = 0; i < emailObj.numberOfAttachments; i++) {
      const attachment = emailObj.getAttachment(i);
      const attachmentName =
        attachment.longFilename || attachment.filename || `attachment_${i}.dat`;
      const mimeType = attachment.mimeTag || "application/octet-stream";

      if (attachment.embeddedPSTMessage) {
        const embeddedEml = buildRawEml(
          attachment.embeddedPSTMessage,
          crypto.randomUUID(),
          "no-date",
          "Attached Message",
        );
        const attachmentBuffer = Buffer.from(embeddedEml, "utf-8");
        emlContent += `--${boundaryMix}\r\nContent-Type: message/rfc822; name="${attachmentName}"\r\nContent-Disposition: attachment; filename="${attachmentName}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachmentBuffer.toString("base64")}\r\n\r\n`;
      } else if (attachment.fileInputStream && attachment.size > 0) {
        const attachmentBuffer = Buffer.alloc(attachment.size);
        attachment.fileInputStream.read(attachmentBuffer);
        emlContent += `--${boundaryMix}\r\nContent-Type: ${mimeType}; name="${attachmentName}"\r\nContent-Disposition: attachment; filename="${attachmentName}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachmentBuffer.toString("base64")}\r\n\r\n`;
      }
    }
    emlContent += `--${boundaryMix}--\r\n`;
  }
  return emlContent;
}

export async function analyzePstDuplicates(
  fileId: string,
  outputBaseDir = process.env.EXTRACTED_PATH ||
    "/Users/rgomes/Projects/extracted_emails",
) {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
  if (!row) throw new Error("File metadata not found.");

  db.prepare(
    "UPDATE processed_files SET status = 'processing' WHERE id = ?",
  ).run(fileId);
  db.prepare("DELETE FROM emails WHERE file_id = ?").run(fileId);

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";

  let cleanRelativePath = "";
  if (row.filepath.startsWith(stagingPath)) {
    const rel = path.relative(stagingPath, row.filepath);
    cleanRelativePath = path.dirname(rel);
  } else {
    cleanRelativePath = fileId;
  }

  if (cleanRelativePath === "." || cleanRelativePath === "") {
    cleanRelativePath = path.parse(row.filepath).name;
  }

  // CRITICAL FIX: Create a file-specific raw folder so multiple PSTs don't delete each other's data
  const targetFolder = path.join(
    outputBaseDir,
    cleanRelativePath,
    `.raw_${fileId}`,
  );
  if (!fs.existsSync(targetFolder))
    fs.mkdirSync(targetFolder, { recursive: true });

  const metrics: AnalysisMetrics = {
    uniqueCount: 0,
    duplicateCount: 0,
    totalProcessed: 0,
    totalAttachments: 0,
  };
  const pst = new PSTFile(row.filepath);

  const checkStmt = db.prepare(
    "SELECT id FROM emails WHERE email_hash = ? LIMIT 1",
  );
  const insertStmt = db.prepare(`
    INSERT INTO emails (id, file_id, message_id, sent_date, email_hash, is_duplicate)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  async function processEmailFolder(folder: PSTFolder, isRoot = false) {
    const displayName = folder.displayName || "";
    if (!isRoot && isSystemOrSearchFolder(displayName)) return;

    if (folder.contentCount > 0) {
      let emailObj = folder.getNextChild();
      while (emailObj !== null) {
        try {
          const sentDate = emailObj.clientSubmitTime
            ? emailObj.clientSubmitTime.toISOString()
            : "no-date";
          const subject = emailObj.subject?.trim() || "no-subject";
          let messageId = (emailObj.internetMessageId || "")
            .replace(/[<>]/g, "")
            .trim();

          if (!messageId && emailObj.transportMessageHeaders) {
            const match = emailObj.transportMessageHeaders.match(
              /Message-ID:\s*<?([^>\s]+)>?/i,
            );
            if (match) messageId = match[1];
          }

          let emailHash: string;
          if (messageId && messageId.length > 5) {
            emailHash = crypto
              .createHash("sha256")
              .update(messageId)
              .digest("hex");
          } else {
            const senderRaw =
              emailObj.senderName || emailObj.senderEmailAddress || "unknown";
            emailHash = generateFallbackHash(
              senderRaw,
              subject,
              emailObj.body || "",
            );
          }

          const existingRecord = checkStmt.get(emailHash) as
            | { id: string }
            | undefined;
          const isDuplicate = existingRecord ? 1 : 0;

          if (isDuplicate === 1) {
            metrics.duplicateCount++;
          } else {
            metrics.uniqueCount++;
            if (emailObj.hasAttachments)
              metrics.totalAttachments += emailObj.numberOfAttachments;
          }
          metrics.totalProcessed++;

          const emailId = crypto.randomUUID();

          // Extract email as EML unconditionally into the secure file-specific folder
          const emlPath = path.join(targetFolder, `${emailId}.eml`);
          const emlContent = buildRawEml(
            emailObj,
            messageId,
            sentDate,
            subject,
          );
          fs.writeFileSync(emlPath, emlContent);

          insertStmt.run(
            emailId,
            fileId,
            messageId,
            sentDate,
            emailHash,
            isDuplicate,
          );
        } catch {
          console.warn(`[PST Warning] Skipping damaged message record.`);
        }
        emailObj = folder.getNextChild();
      }
    }
    for (const sub of safeGetSubFolders(folder)) {
      await processEmailFolder(sub, false);
    }
  }

  await processEmailFolder(pst.getRootFolder(), true);

  // Detect and physically remove duplicated EML files from the disk
  const duplicateRecords = db
    .prepare("SELECT id FROM emails WHERE file_id = ? AND is_duplicate = 1")
    .all(fileId) as { id: string }[];

  for (const dup of duplicateRecords) {
    const dupPath = path.join(targetFolder, `${dup.id}.eml`);
    if (fs.existsSync(dupPath)) fs.unlinkSync(dupPath);
  }

  db.prepare(`
    UPDATE processed_files 
    SET status = 'analyzed', total_emails = ?, unique_emails = ?, duplicate_emails = ?, total_attachments = ?
    WHERE id = ?
  `).run(
    metrics.totalProcessed,
    metrics.uniqueCount,
    metrics.duplicateCount,
    metrics.totalAttachments,
    fileId,
  );

  return metrics;
}
