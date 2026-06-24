import fs from "node:fs";
import path from "node:path";
import { db } from "./src/lib/db";

const extractedPath =
  process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";
const stagingPath =
  process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";

console.log("Rebuilding Unified Export folder...");

// 1. Reset Dashboard Button
db.prepare("UPDATE processed_files SET pdf_status = 'pending'").run();

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
  const exportDir = path.join(targetFolder, "export");
  const deliverablesDir = path.join(targetFolder, "Deliverables");

  // WIPE EVERYTHING CLEAN to remove ghost files from old runs!
  if (fs.existsSync(exportDir))
    fs.rmSync(exportDir, { recursive: true, force: true });
  if (fs.existsSync(deliverablesDir))
    fs.rmSync(deliverablesDir, { recursive: true, force: true });

  fs.mkdirSync(exportDir, { recursive: true });

  // Get ALL approved emails for ALL PST files in this specific case combined
  const placeholders = fileIds.map(() => "?").join(",");
  const approvedEmails = db
    .prepare(`
    SELECT email_hash, sent_date 
    FROM emails 
    WHERE file_id IN (${placeholders}) AND ai_decision = 'keep' AND is_duplicate = 0
  `)
    .all(...fileIds) as { email_hash: string; sent_date: string }[];

  // Sort ALL emails chronologically to create a single master timeline
  approvedEmails.sort((a, b) => a.sent_date.localeCompare(b.sent_date));
  const padLength = Math.max(4, approvedEmails.length.toString().length);

  console.log(
    `[Case: ${caseName}] Found ${approvedEmails.length} unified approved emails. Copying to export...`,
  );

  for (let i = 0; i < approvedEmails.length; i++) {
    const item = approvedEmails[i];
    const newSeqName = `Email ${String(i + 1).padStart(padLength, "0")}`;

    const sourceEmlPath = path.join(targetFolder, `${item.email_hash}.eml`);
    const destEmlPath = path.join(exportDir, `${newSeqName}.eml`);

    if (fs.existsSync(sourceEmlPath)) {
      fs.copyFileSync(sourceEmlPath, destEmlPath);
    }
  }
}

console.log(
  "Database and folders reset! You can now click Compile PDFs in the UI.",
);
