import { NextResponse } from "next/server";
import { wipeCaseData } from "@/lib/request-reset";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      confirmation?: string;
    };
    const wiped = await wipeCaseData(caseId, body.confirmation ?? "");
    return NextResponse.json({ success: true, wiped });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to wipe case data.",
      },
      { status: 400 },
    );
  }
}
