import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { generateBatchFile } from "./ai";
import { db } from "./db";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function pollBatchStatus(fileId: string) {
  const row = db
    .prepare(
      "SELECT filepath, batch_id, subject_name, subject_email, subject_aliases FROM processed_files WHERE id = ?",
    )
    .get(fileId) as
    | {
        filepath: string;
        batch_id: string;
        subject_name?: string;
        subject_email?: string;
        subject_aliases?: string;
      }
    | undefined;

  if (!row || !row.batch_id) return "no_batch";

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

  console.log(`[Batch Worker] Checking status of batch: ${row.batch_id}...`);
  const batch = await openai.batches.retrieve(row.batch_id);

  if (batch.status === "completed" && batch.output_file_id) {
    db.prepare(
      "UPDATE processed_files SET ai_status = 'processing' WHERE id = ?",
    ).run(fileId);

    console.log(
      `[Batch Worker] Downloading results from file ${batch.output_file_id}...`,
    );
    const fileResponse = await openai.files.content(batch.output_file_id);
    const content = await fileResponse.text();
    const lines = content.trim().split("\n");

    let keepCount = 0;
    let discardCount = 0;

    const keptHashes: string[] = [];
    const updateStmt = db.prepare(
      "UPDATE emails SET ai_decision = ?, ai_reason = ? WHERE email_hash = ? AND file_id = ?",
    );

    db.transaction(() => {
      for (const line of lines) {
        if (!line.trim()) continue;
        const responseObj = JSON.parse(line);
        const emailHash = responseObj.custom_id;

        const bodyContent = responseObj.response?.body;
        if (!bodyContent) continue;

        const choice = bodyContent.choices[0];
        const rawJson = choice.message.content.trim();
        const cleanJson = rawJson
          .replace(/^```json\s*/i, "")
          .replace(/\s*```$/i, "");
        const decisionData = JSON.parse(cleanJson);

        const decision = decisionData.decision === "keep" ? "keep" : "discard";
        const reason = decisionData.reason || "Audited via GPT.";

        updateStmt.run(decision, reason, emailHash, fileId);

        if (decision === "keep") {
          keepCount++;
          keptHashes.push(emailHash);
        } else {
          discardCount++;
        }
      }
    })();

    if (keptHashes.length > 0) {
      const exportDir = path.join(targetFolder, "export");
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      const placeholders = keptHashes.map(() => "?").join(",");
      const approvedEmails = db
        .prepare(`
        SELECT email_hash, sent_date 
        FROM emails 
        WHERE email_hash IN (${placeholders}) AND file_id = ?
      `)
        .all(...keptHashes, fileId) as {
        email_hash: string;
        sent_date: string;
      }[];

      approvedEmails.sort((a, b) => a.sent_date.localeCompare(b.sent_date));

      const existingEmailNumbers = fs
        .readdirSync(exportDir)
        .map((f) => /^Email\s+(\d+)\.eml$/i.exec(f)?.[1])
        .filter((value): value is string => Boolean(value))
        .map(Number);

      const startAt =
        existingEmailNumbers.length > 0
          ? Math.max(...existingEmailNumbers) + 1
          : 1;
      const finalNumber = startAt + approvedEmails.length - 1;
      const padLength = Math.max(4, String(finalNumber).length);

      for (let i = 0; i < approvedEmails.length; i++) {
        const item = approvedEmails[i];
        const newSeqName = `Email ${String(startAt + i).padStart(padLength, "0")}`;

        const sourceEmlPath = path.join(targetFolder, `${item.email_hash}.eml`);
        const destEmlPath = path.join(exportDir, `${newSeqName}.eml`);

        if (fs.existsSync(sourceEmlPath)) {
          fs.copyFileSync(sourceEmlPath, destEmlPath);
        }
      }
    }

    db.prepare(`
      UPDATE processed_files
      SET ai_approved_count = ai_approved_count + ?,
          ai_discarded_count = ai_discarded_count + ?
      WHERE id = ?
    `).run(keepCount, discardCount, fileId);

    const remaining = db
      .prepare(
        "SELECT count(*) as c FROM emails WHERE file_id = ? AND is_duplicate = 0 AND ai_decision IS NULL",
      )
      .get(fileId) as { c: number };

    if (remaining.c > 0) {
      console.log(
        `[Batch Worker] Chunk complete. ${remaining.c} items remaining. Generating next chunk immediately...`,
      );
      db.prepare(
        "UPDATE processed_files SET ai_status = 'processing', batch_id = NULL WHERE id = ?",
      ).run(fileId);

      generateBatchFile(fileId, {
        name: row.subject_name || "",
        email: row.subject_email || "",
        aliases: row.subject_aliases
          ? row.subject_aliases
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean)
          : [],
      }).catch((err) => {
        console.error(
          `[Batch Worker] Fatal error generating next chunk for ${fileId}:`,
          err,
        );
        db.prepare(
          "UPDATE processed_files SET ai_status = 'failed' WHERE id = ?",
        ).run(fileId);
      });

      return "requeued";
    }

    console.log(
      `[Batch Worker] All AI chunks completed successfully for file ${fileId}.`,
    );
    db.prepare(
      "UPDATE processed_files SET ai_status = 'completed', batch_id = NULL WHERE id = ?",
    ).run(fileId);
    return "completed";
  }

  if (
    batch.status === "failed" ||
    batch.status === "expired" ||
    batch.status === "cancelled"
  ) {
    console.error(
      `[Batch Worker] OpenAI batch execution failed/cancelled. Status: ${batch.status}`,
    );
    db.prepare(
      "UPDATE processed_files SET ai_status = 'failed' WHERE id = ?",
    ).run(fileId);
  }

  return batch.status;
}
