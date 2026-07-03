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

// Multi-process safety pragmas (API routes + detached workers).
// WAL allows concurrent readers while a writer is active; busy_timeout makes
// transient write contention wait instead of failing immediately.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA busy_timeout = 10000;");

// Shared SQLITE_BUSY handling. Multiple processes (API routes + detached
// workers) write concurrently; a transient lock should be retried, not fatal.
export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("sqlite_busy") ||
    message.includes("database is locked") ||
    message.includes("database is busy")
  );
}

export async function withSqliteBusyRetry<T>(
  op: () => T,
  label: string,
  attempts = 8,
): Promise<T> {
  let delayMs = 50;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return op();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt === attempts) throw error;
      lastError = error;
      console.warn(
        `[DB] SQLITE_BUSY during ${label} (attempt ${attempt}/${attempts}). Retrying in ${delayMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 800);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`SQLITE_BUSY retries exhausted during ${label}`);
}

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
    ai_batches_total INTEGER DEFAULT 0,
    ai_batches_done INTEGER DEFAULT 0,
    pdf_status TEXT DEFAULT 'pending',
    batch_id TEXT,
    subject_name TEXT,
    subject_email TEXT,
    subject_aliases TEXT,
    metadata_duration_ms INTEGER DEFAULT 0,
    analyze_duration_ms INTEGER DEFAULT 0,
    extract_duration_ms INTEGER DEFAULT 0,
    ai_started_at INTEGER,
    ai_duration_ms INTEGER DEFAULT 0,
    pdf_duration_ms INTEGER DEFAULT 0,
    kind TEXT DEFAULT 'pst',
    files_status TEXT DEFAULT 'pending',
    files_total INTEGER DEFAULT 0,
    files_processed INTEGER DEFAULT 0,
    files_skipped INTEGER DEFAULT 0,
    files_duplicates INTEGER DEFAULT 0,
    files_duration_ms INTEGER DEFAULT 0,
    files_started_at INTEGER
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
  db.exec("ALTER TABLE processed_files ADD COLUMN ai_started_at INTEGER");
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN ai_duration_ms INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN ai_batches_total INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN ai_batches_done INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN pdf_duration_ms INTEGER DEFAULT 0",
  );
} catch (_e) {}

// Merged pipeline: distinguish PST rows from "Files" (Teams/docs) batch rows,
// and track the Files phase status + metrics on the same table.
try {
  db.exec("ALTER TABLE processed_files ADD COLUMN kind TEXT DEFAULT 'pst'");
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN files_status TEXT DEFAULT 'pending'",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN files_total INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN files_processed INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN files_skipped INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN files_duplicates INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec(
    "ALTER TABLE processed_files ADD COLUMN files_duration_ms INTEGER DEFAULT 0",
  );
} catch (_e) {}
try {
  db.exec("ALTER TABLE processed_files ADD COLUMN files_started_at INTEGER");
} catch (_e) {}
