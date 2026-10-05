import { NextResponse } from "next/server";
import { continueRequest } from "@/lib/cases";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await context.params;
    const { add } = (await request.json()) as { add?: string };
    const updated = await continueRequest(requestId, add ?? "");
    return NextResponse.json({
      request: {
        ...updated,
        pst_size_bytes: Number(updated.pst_size_bytes),
        files_size_bytes: Number(updated.files_size_bytes),
        deliverable_size_bytes: Number(updated.deliverable_size_bytes),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to continue request.",
      },
      { status: 400 },
    );
  }
}
