import { spawn } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Prevent Vercel/Next.js from caching this route statically
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fileId } = body;

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: fileId" },
        { status: 400 },
      );
    }

    // Check file status in DB
    const row = db
      .prepare("SELECT ai_status, pdf_status FROM processed_files WHERE id = ?")
      .get(fileId) as { ai_status: string; pdf_status: string } | undefined;

    if (!row) {
      return NextResponse.json(
        { success: false, error: "File record not found." },
        { status: 404 },
      );
    }

    // Ensure AI audit is finished first
    if (row.ai_status !== "completed") {
      return NextResponse.json(
        {
          success: false,
          error: "AI Audit must be completed before generating PDFs.",
        },
        { status: 400 },
      );
    }

    // Prevent double-triggering
    if (row.pdf_status === "processing") {
      return NextResponse.json(
        { success: false, error: "PDF conversion is already in progress." },
        { status: 409 },
      );
    }

    // Enqueue this file. The worker will claim it when it's its turn.
    db.prepare(
      "UPDATE processed_files SET pdf_status = 'pending', pdf_duration_ms = 0 WHERE id = ?",
    ).run(fileId);

    console.log(`Queued PDF conversion for file: ${fileId}`);

    // Only spawn a worker if one isn't already running.
    // A running worker is identified by any file having pdf_status = 'processing'.
    const workerAlreadyRunning = db
      .prepare(
        "SELECT 1 FROM processed_files WHERE pdf_status = 'processing' LIMIT 1",
      )
      .get();

    if (!workerAlreadyRunning) {
      const workerPath = path.resolve(process.cwd(), "convert-worker.ts");
      const child = spawn("bun", [workerPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }

    return NextResponse.json(
      { success: true, message: "PDF conversion job initiated." },
      { status: 202 },
    );
  } catch (error) {
    console.error("API route /api/convert encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
