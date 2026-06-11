import { Database } from "bun:sqlite";

// Set the explicit external path to prevent Next.js from watching the file
const dbPath = process.env.DATABASE_PATH || "/Users/rafaelaguiar/Projects/databases/pst_analyzer.db";
export const db = new Database(dbPath);

/**
 * Initializes the database tables required for the PST Analyzer.
 * - `processed_files`: Tracks the files inside the staging directory.
 * - `emails`: Stores metadata and unique hashes of emails to detect duplicates.
 */
export function initDatabase() {
  // Create table to track ZIP/PST files found or uploaded
  db.run(`
    CREATE TABLE IF NOT EXISTS processed_files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
      total_emails INTEGER DEFAULT 0,
      total_attachments INTEGER DEFAULT 0,
      unique_emails INTEGER DEFAULT 0,
      duplicate_emails INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create table to store individual email hashes for de-duplication
  db.run(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY, -- Generated UUID or sequential ID
      file_id TEXT NOT NULL,
      message_id TEXT,     -- The Internet Message ID from the headers
      sent_date TEXT,      -- Client submit time / string date
      email_hash TEXT NOT NULL, -- Combined SHA-256 hash of ID + content
      is_duplicate INTEGER DEFAULT 0, -- 0 = Unique, 1 = Duplicate
      FOREIGN KEY (file_id) REFERENCES processed_files(id) ON DELETE CASCADE
    );
  `);

  // Create an index on the email_hash to make duplicate lookup lightning fast
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_email_hash ON emails(email_hash);
  `);
}

// Automatically initialize tables when this helper is imported
initDatabase();