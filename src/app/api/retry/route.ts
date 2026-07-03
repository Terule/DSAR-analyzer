import { NextResponse } from "next/server";
import { getCasePstFileIds } from "@/lib/case-utils";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { fileId } = await request.json();

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: fileId" },
        { status: 400 },
      );
    }

    const row = db
      .prepare(
        "SELECT status, pdf_status, ai_status, total_emails, unique_emails FROM processed_files WHERE id = ?",
      )
      .get(fileId) as
      | {
          status: string;
          pdf_status: string;
          ai_status: string;
          total_emails: number;
          unique_emails: number;
        }
      | undefined;

    if (!row) {
      return NextResponse.json(
        { success: false, error: "File not found" },
        { status: 404 },
      );
    }

    // 1. Reset PDF compilation failures. Render is case-level (all PST files in
    // the request share the selected/ folder), so reset every PST row in the case.
    if (row.pdf_status === "failed") {
      const caseIds = getCasePstFileIds(fileId);
      const placeholders = caseIds.map(() => "?").join(",");
      db.prepare(
        `UPDATE processed_files SET pdf_status = 'pending', pdf_duration_ms = 0 WHERE id IN (${placeholders})`,
      ).run(...caseIds);
    }
    // 2. Reset AI Batch processing failures. AI is case-level (one run audits
    // the whole request), so reset every PST row; the coordinator re-runs and
    // resumes from undecided emails.
    else if (row.ai_status === "failed") {
      const caseIds = getCasePstFileIds(fileId);
      const placeholders = caseIds.map(() => "?").join(",");
      db.prepare(
        `UPDATE processed_files SET ai_status = 'pending', ai_started_at = NULL WHERE id IN (${placeholders})`,
      ).run(...caseIds);
    }
    // 3. Reset standard pipeline failures (metadata, analyze, extract). These
    // are inherently per-file (each PST is parsed/extracted independently).
    else if (row.status === "failed") {
      // If metadata never completed, reset to the very beginning
      if (row.total_emails === 0) {
        db.prepare(
          "UPDATE processed_files SET status = 'pending' WHERE id = ?",
        ).run(fileId);
      }
      // If analysis never completed, reset to pending analysis
      else if (row.unique_emails === 0) {
        db.prepare(
          "UPDATE processed_files SET status = 'pending_analysis' WHERE id = ?",
        ).run(fileId);
      }
      // Otherwise, if it failed during extraction, reset to analyzed
      else {
        db.prepare(
          "UPDATE processed_files SET status = 'analyzed' WHERE id = ?",
        ).run(fileId);
      }
    }

    return NextResponse.json(
      { success: true, message: "State successfully reverted." },
      { status: 200 },
    );
  } catch (error) {
    console.error("Retry API Route Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
