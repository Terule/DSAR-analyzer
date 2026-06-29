import fs from "node:fs";
import path from "node:path";
import { db } from "./src/lib/db";

const extractedPath =
  process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";
const stagingPath =
  process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";

console.log("Rebuilding Unified Export folder...");

// 1. Reset Dashboard Button
db.prepare(
  "UPDATE processed_files SET pdf_status = 'pending', pdf_duration_ms = 0",
).run();

const files = db.prepare("SELECT id, filepath FROM processed_files").all() as {
  id: string;
  filepath: string;
}[];

// Group files by their Case directory (e.g., MB/R2)
const cases: Record<string, string[]> = {};

for (const file of files) {
  let relativeSystemPath = path.relative(stagingPath, file.filepath);
  if (
    relativeSystemPath.startsWith("..") ||
    path.isAbsolute(relativeSystemPath)
  ) {
    relativeSystemPath = file.id;
  }
  let cleanRelativePath = path.dirname(relativeSystemPath);
  if (cleanRelativePath === "." || cleanRelativePath === "")
    cleanRelativePath = path.parse(relativeSystemPath).name;

  if (!cases[cleanRelativePath]) cases[cleanRelativePath] = [];
  cases[cleanRelativePath].push(file.id);
}

// Process each Case as a Unified Batch
for (const [caseName, fileIds] of Object.entries(cases)) {
  const targetFolder = path.join(extractedPath, caseName);
  const uniqueEmailsDir = path.join(targetFolder, ".unique-emails");
  const rawDir = path.join(uniqueEmailsDir, "raw-emails");
  const selectedDir = path.join(uniqueEmailsDir, "selected");
  const discardedDir = path.join(uniqueEmailsDir, "discarded");
  const emailsDir = path.join(targetFolder, "Emails");
  const logsDir = path.join(targetFolder, ".logs");

  // Wipe only folders tied to PDF compilation and AI selection buckets.
  if (fs.existsSync(selectedDir))
    fs.rmSync(selectedDir, { recursive: true, force: true });
  if (fs.existsSync(discardedDir))
    fs.rmSync(discardedDir, { recursive: true, force: true });
  if (fs.existsSync(emailsDir))
    fs.rmSync(emailsDir, { recursive: true, force: true });
  if (fs.existsSync(logsDir))
    fs.rmSync(logsDir, { recursive: true, force: true });

  fs.mkdirSync(selectedDir, { recursive: true });
  fs.mkdirSync(discardedDir, { recursive: true });

  // Rebuild selection buckets from DB decisions across all PSTs in this case.
  const placeholders = fileIds.map(() => "?").join(",");
  const selectedEmails = db
    .prepare(`
    SELECT email_hash, sent_date 
    FROM emails 
    WHERE file_id IN (${placeholders}) AND ai_decision = 'keep' AND is_duplicate = 0
  `)
    .all(...fileIds) as { email_hash: string; sent_date: string }[];

  const discardedEmails = db
    .prepare(`
    SELECT email_hash, sent_date 
    FROM emails 
    WHERE file_id IN (${placeholders}) AND ai_decision = 'discard' AND is_duplicate = 0
  `)
    .all(...fileIds) as { email_hash: string; sent_date: string }[];

  selectedEmails.sort((a, b) => a.sent_date.localeCompare(b.sent_date));
  discardedEmails.sort((a, b) => a.sent_date.localeCompare(b.sent_date));

  console.log(
    `[Case: ${caseName}] Rebuilding selected (${selectedEmails.length}) and discarded (${discardedEmails.length}) buckets...`,
  );

  for (const item of selectedEmails) {
    const sourceEmlPath = path.join(rawDir, `${item.email_hash}.eml`);
    const legacySourcePath = path.join(targetFolder, `${item.email_hash}.eml`);
    const destEmlPath = path.join(selectedDir, `${item.email_hash}.eml`);

    if (fs.existsSync(sourceEmlPath))
      fs.copyFileSync(sourceEmlPath, destEmlPath);
    else if (fs.existsSync(legacySourcePath))
      fs.copyFileSync(legacySourcePath, destEmlPath);
  }

  for (const item of discardedEmails) {
    const sourceEmlPath = path.join(rawDir, `${item.email_hash}.eml`);
    const legacySourcePath = path.join(targetFolder, `${item.email_hash}.eml`);
    const destEmlPath = path.join(discardedDir, `${item.email_hash}.eml`);

    if (fs.existsSync(sourceEmlPath))
      fs.copyFileSync(sourceEmlPath, destEmlPath);
    else if (fs.existsSync(legacySourcePath))
      fs.copyFileSync(legacySourcePath, destEmlPath);
  }
}

console.log(
  "PDF state and selection folders rebuilt. You can now click Compile PDFs in the UI.",
);
