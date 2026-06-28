import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

// 1. Prioritize the .env variable, but fallback to the absolute path
const dbPath =
  process.env.DATABASE_PATH ||
  "/Users/rgomes/Projects/databases/pst_analyzer.db";
const dbDir = path.dirname(dbPath);

// 2. Create the directory BEFORE initializing the database
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 3. Connect using Bun's native driver
export const db = new Database(dbPath);

// 4. Create the final Architecture Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_files (
    id TEXT PRIMARY KEY,
    filename TEXT,
    filepath TEXT,
    file_size_bytes INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    total_emails INTEGER DEFAULT 0,
    total_attachments INTEGER DEFAULT 0,
    unique_emails INTEGER DEFAULT 0,
    duplicate_emails INTEGER DEFAULT 0,
    estimated_tokens INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_status TEXT DEFAULT 'pending',
    ai_approved_count INTEGER DEFAULT 0,
    ai_discarded_count INTEGER DEFAULT 0,
    pdf_status TEXT DEFAULT 'pending',
    batch_id TEXT,
    subject_name TEXT,
    subject_email TEXT,
    subject_aliases TEXT,
    metadata_duration_ms INTEGER DEFAULT 0,
    analyze_duration_ms INTEGER DEFAULT 0,
    extract_duration_ms INTEGER DEFAULT 0,
    ai_duration_ms INTEGER DEFAULT 0,
    pdf_duration_ms INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    file_id TEXT,
    message_id TEXT,
    sent_date TEXT,
    email_hash TEXT UNIQUE,
    is_duplicate INTEGER DEFAULT 0,
    parent_email_hash TEXT NULL,       
    is_attachment INTEGER DEFAULT 0,     
    ai_decision TEXT,
    ai_reason TEXT,
    FOREIGN KEY(file_id) REFERENCES processed_files(id),
    FOREIGN KEY(parent_email_hash) REFERENCES emails(email_hash)
  );
`);

// Safe runtime migration block to support existing databases (Non-Destructive!)
try {
  db.exec("ALTER TABLE processed_files ADD COLUMN subject_name TEXT");
} catch (_e) {}
try {
  db.exec("ALTER TABLE processed_files ADD COLUMN subject_email TEXT");
} catch (_e) {}
try {
  db.exec("ALTER TABLE processed_files ADD COLUMN subject_aliases TEXT");
} catch (_e) {}

// Duration Tracking Columns
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN metadata_duration_ms INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN analyze_duration_ms INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN extract_duration_ms INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN ai_duration_ms INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN pdf_duration_ms INTEGER DEFAULT 0",
  );
} catch (_e) {}
