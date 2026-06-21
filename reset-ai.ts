import { db } from "./src/lib/db";

// 1. Roll the orchestrator back to the AI Phase
db.prepare(
  "UPDATE processed_files SET ai_status = 'pending', pdf_status = 'pending'",
).run();

// 2. Clear any partial AI decisions so it evaluates cleanly
db.prepare("UPDATE emails SET ai_decision = NULL, ai_reason = NULL").run();

console.log("Database reset successfully! Check your Dashboard.");
