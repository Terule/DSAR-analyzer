import { NextResponse } from "next/server";
import { generateBatchFile } from "@/lib/ai";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { fileId, subjectCriteria } = await request.json();

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: fileId" },
        { status: 400 },
      );
    }

    const row = db
      .prepare(
        "SELECT status, subject_name, subject_email, subject_aliases FROM processed_files WHERE id = ?",
      )
      .get(fileId) as
      | {
          status: string;
          subject_name?: string;
          subject_email?: string;
          subject_aliases?: string;
        }
      | undefined;

    if (!row || row.status !== "completed") {
      return NextResponse.json(
        {
          success: false,
          error: "File must be extracted before AI batch generation.",
        },
        { status: 400 },
      );
    }

    // 1. Resolve subject criteria from request or fallback to saved database config
    let finalCriteria = subjectCriteria;
    if (!finalCriteria) {
      if (row.subject_name && row.subject_email) {
        finalCriteria = {
          name: row.subject_name,
          email: row.subject_email,
          aliases: row.subject_aliases
            ? row.subject_aliases
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        };
      } else {
        return NextResponse.json(
          { success: false, error: "Missing subject criteria configuration." },
          { status: 400 },
        );
      }
    }

    // 🚨 Instantly lock the file status to 'processing'
    // This tells the React Master Orchestrator to stop and wait before firing the next file.
    db.prepare(
      "UPDATE processed_files SET ai_status = 'processing' WHERE id = ?",
    ).run(fileId);

    // Trigger the Batch generation process safely in the background
    setTimeout(() => {
      generateBatchFile(fileId, finalCriteria).catch((err) => {
        console.error(`Batch generation crashed for file ${fileId}:`, err);
        db.prepare(
          "UPDATE processed_files SET ai_status = 'failed' WHERE id = ?",
        ).run(fileId);
      });
    }, 50);

    return NextResponse.json(
      { success: true, message: "AI Batch job generation initiated" },
      { status: 202 },
    );
  } catch (error) {
    console.error("API route /api/filter encountered an error:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
