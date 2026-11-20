import { NextResponse } from "next/server";
import { resetRequestData } from "@/lib/request-reset";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await context.params;
    await resetRequestData(requestId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to reset request.",
      },
      { status: 400 },
    );
  }
}
