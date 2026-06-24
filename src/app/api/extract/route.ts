import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { extractUniqueEmails } from "@/lib/exporter";

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

    if (row.status !== "analyzed") {
      return NextResponse.json(
        {
          success: false,
          error: "File must be analyzed first before extraction.",
        },
        { status: 400 },
      );
    }

    // CRITICAL FIX: Await the heavy I/O to ensure all JSONs are written to disk securely
    await extractUniqueEmails(fileId);

    return NextResponse.json(
      { success: true, message: "Extraction completed" },
      { status: 200 },
    );
  } catch (error) {
    console.error("API route /api/extract encountered an error:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
