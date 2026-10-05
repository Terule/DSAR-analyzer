import { NextResponse } from "next/server";
import { deleteUnusedRequest } from "@/lib/cases";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await context.params;
    const { alreadyDeleted } = await deleteUnusedRequest(requestId);
    return NextResponse.json({ success: true, alreadyDeleted });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to delete request.",
      },
      { status: 400 },
    );
  }
}
