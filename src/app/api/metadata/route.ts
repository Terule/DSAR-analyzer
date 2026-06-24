import { NextResponse } from "next/server";
import { scanFileMetadata } from "@/lib/analyzer";
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
      .prepare("SELECT status FROM processed_files WHERE id = ?")
      .get(fileId) as { status: string } | undefined;

    if (!row || row.status !== "pending") {
      return NextResponse.json(
        { success: false, error: "Invalid status for metadata scan." },
        { status: 400 },
      );
    }

    db.prepare(
      "UPDATE processed_files SET status = 'scanning_metadata' WHERE id = ?",
    ).run(fileId);

    // Timeout de 100ms destrava o botão instantaneamente
    setTimeout(() => {
      scanFileMetadata(fileId).catch((err: unknown) => {
        console.error(`Metadata background worker crashed for ${fileId}:`, err);
        db.prepare(
          "UPDATE processed_files SET status = 'failed' WHERE id = ?",
        ).run(fileId);
      });
    }, 100);

    return NextResponse.json({ success: true }, { status: 202 });
  } catch (error) {
    console.error("Metadata API Error:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
