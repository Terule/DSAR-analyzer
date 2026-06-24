import { NextResponse } from "next/server";
import { convertToPdfBatch } from "@/lib/converter";
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

    console.log(`Received request to start PDF conversion for file: ${fileId}`);

    // MUST AWAIT THIS: Otherwise Next.js will kill the Puppeteer process silently!
    await convertToPdfBatch(fileId);

    // Return 200 OK indicating the job has finished safely
    return NextResponse.json(
      { success: true, message: "PDF conversion completed successfully." },
      { status: 200 },
    );
  } catch (error) {
    console.error("API route /api/convert encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
