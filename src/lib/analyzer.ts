import crypto from "node:crypto";
import { PSTFile, type PSTFolder } from "pst-extractor";
import { db } from "./db";

interface AnalysisMetrics {
  uniqueCount: number;
  duplicateCount: number;
  totalProcessed: number;
}

async function processEmailFolder(
  folder: PSTFolder,
  fileId: string,
  metrics: AnalysisMetrics,
): Promise<void> {
  if (folder.contentCount > 0) {
    let email = folder.getNextChild();

    const checkStmt = db.prepare(
      "SELECT id FROM emails WHERE email_hash = ? LIMIT 1",
    );
    const insertStmt = db.prepare(`
      INSERT INTO emails (id, file_id, message_id, sent_date, email_hash, is_duplicate)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    while (email !== null) {
      // Garantimos que valores vazios não gerem hashes colidentes
      const messageId = email.internetMessageId?.trim() || "";
      const sentDate = email.clientSubmitTime
        ? email.clientSubmitTime.toISOString()
        : "no-date";
      const subject = email.subject?.trim() || "no-subject";

      // Hash mais robusto: prefere Message-ID, mas usa metadados de corpo/assunto se ID faltar
      let emailHash: string;
      if (messageId && messageId.length > 5) {
        emailHash = crypto.createHash("sha256").update(messageId).digest("hex");
      } else {
        // Fallback para e-mails sem Message-ID (geralmente e-mails internos ou corrompidos)
        emailHash = crypto
          .createHash("sha256")
          .update(
            `${subject}_${sentDate}_${email.body?.substring(0, 500) || ""}`,
          )
          .digest("hex");
      }

      // Verifica se este hash já existe na tabela de e-mails global.
      const existingRecord = checkStmt.get(emailHash);
      const isDuplicate = existingRecord ? 1 : 0;

      if (isDuplicate === 1) {
        metrics.duplicateCount += 1;
      } else {
        metrics.uniqueCount += 1;
      }

      metrics.totalProcessed += 1;

      const generatedId = crypto.randomUUID();
      insertStmt.run(
        generatedId,
        fileId,
        messageId,
        sentDate,
        emailHash,
        isDuplicate,
      );

      // Feedback progressivo para o front
      if (metrics.totalProcessed % 50 === 0) {
        db.prepare(`
          UPDATE processed_files 
          SET unique_emails = ?, duplicate_emails = ? 
          WHERE id = ?
        `).run(metrics.uniqueCount, metrics.duplicateCount, fileId);

        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      email = folder.getNextChild();
    }
  }

  if (folder.hasSubfolders) {
    for (const subFolder of folder.getSubFolders()) {
      await processEmailFolder(subFolder, fileId, metrics);
    }
  }
}

export async function analyzePstDuplicates(
  fileId: string,
): Promise<AnalysisMetrics> {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;

  if (!row) {
    throw new Error(`File target reference missing for identifier: ${fileId}`);
  }

  // Limpa registros anteriores de e-mails deste arquivo para evitar contagem inflada em re-análises
  db.prepare("DELETE FROM emails WHERE file_id = ?").run(fileId);

  db.prepare(
    "UPDATE processed_files SET status = 'processing', unique_emails = 0, duplicate_emails = 0 WHERE id = ?",
  ).run(fileId);

  const metrics: AnalysisMetrics = {
    uniqueCount: 0,
    duplicateCount: 0,
    totalProcessed: 0,
  };

  try {
    const pstFile = new PSTFile(row.filepath);
    const rootFolder = pstFile.getRootFolder();

    await processEmailFolder(rootFolder, fileId, metrics);

    db.prepare(`
      UPDATE processed_files 
      SET unique_emails = ?, duplicate_emails = ?, status = 'analyzed'
      WHERE id = ?
    `).run(metrics.uniqueCount, metrics.duplicateCount, fileId);

    return metrics;
  } catch (error) {
    db.prepare("UPDATE processed_files SET status = 'failed' WHERE id = ?").run(
      fileId,
    );
    console.error(
      `Deduplication run encountered a fatal error on ${fileId}:`,
      error,
    );
    throw error;
  }
}

export async function scanFileMetadata(fileId: string): Promise<void> {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;

  if (!row) return;

  try {
    const pstFile = new PSTFile(row.filepath);
    const rootFolder = pstFile.getRootFolder();

    let totalEmails = 0;

    async function countFolder(folder: PSTFolder) {
      totalEmails += folder.contentCount;

      if (folder.hasSubfolders) {
        for (const sub of folder.getSubFolders()) {
          await countFolder(sub);
        }
      }
    }

    await countFolder(rootFolder);

    db.prepare(`
      UPDATE processed_files 
      SET total_emails = ?, status = 'pending_analysis' 
      WHERE id = ?
    `).run(totalEmails, fileId);
  } catch (error) {
    console.error(`Initial metadata scan failed on ${fileId}:`, error);
    db.prepare("UPDATE processed_files SET status = 'failed' WHERE id = ?").run(
      fileId,
    );
  }
}
