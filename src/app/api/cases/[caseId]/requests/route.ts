import { NextResponse } from "next/server";
import { addManagedRequest } from "@/lib/cases";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const created = await addManagedRequest(caseId, await request.json());
    return NextResponse.json(
      {
        request: {
          ...created,
          pst_size_bytes: Number(created.pst_size_bytes),
          files_size_bytes: Number(created.files_size_bytes),
          deliverable_size_bytes: Number(created.deliverable_size_bytes),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to add request.",
      },
      { status: 400 },
    );
  }
}
