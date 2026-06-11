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

    db.prepare(
      "UPDATE processed_files SET status = 'processing' WHERE id = ?",
    ).run(fileId);

    // Timeout de 100ms destrava o botão instantaneamente
    setTimeout(() => {
      analyzePstDuplicates(fileId).catch((err) => {
        console.error(
          `Background processing engine crashed for file ${fileId}:`,
          err,
        );
        db.prepare(
          "UPDATE processed_files SET status = 'failed' WHERE id = ?",
        ).run(fileId);
      });
    }, 100);

    return NextResponse.json(
      { success: true, message: "Analysis initiated" },
      { status: 202 },
    );
  } catch (error) {
    console.error("API route /api/analyze encountered an error:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
