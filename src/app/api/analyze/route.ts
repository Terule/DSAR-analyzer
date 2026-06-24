import { NextResponse } from "next/server";
import { analyzePstDuplicates } from "@/lib/analyzer";
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
      .prepare("SELECT id, status FROM processed_files WHERE id = ?")
      .get(fileId) as { status: string } | undefined;

    if (!row) {
      return NextResponse.json(
        { success: false, error: "File not found." },
        { status: 404 },
      );
    }

    if (row.status !== "pending_analysis") {
      return NextResponse.json(
        {
          success: false,
          error: "File must complete metadata scanning first.",
        },
        { status: 400 },
      );
    }

    // Set UI to processing immediately
    db.prepare(
      "UPDATE processed_files SET status = 'processing' WHERE id = ?",
    ).run(fileId);

    // CRITICAL FIX: We MUST await this operation.
    // If we return the response before this finishes, the Node.js process
    // may abruptly terminate the file system (fs) write streams.
    await analyzePstDuplicates(fileId);

    return NextResponse.json(
      { success: true, message: "Analysis completed" },
      { status: 200 },
    );
  } catch (error) {
    console.error(`API route /api/analyze encountered an error:`, error);
    return NextResponse.json(
      { success: false, error: "Analysis failed." },
      { status: 500 },
    );
  }
}
