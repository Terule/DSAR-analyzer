import { NextResponse } from "next/server";
import { pollBatchStatus } from "@/lib/batch-worker";

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

    // Trigger the manual poll
    // We await this to ensure the status is updated before returning the response
    await pollBatchStatus(fileId);

    return NextResponse.json(
      { success: true, message: "Status sync complete" },
      { status: 200 },
    );
  } catch (error) {
    console.error("API route /api/batch-poll encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
