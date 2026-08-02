import { NextResponse } from "next/server";
import { removeRequestFolders } from "@/lib/cases";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const item = await prisma.managedCase.findUnique({
      where: { id: caseId },
      include: { requests: true },
    });
    if (!item || item.status !== "active")
      throw new Error("Active case not found.");
    if (
      item.requests.length === 0 ||
      item.requests.some((request) => request.status !== "completed")
    )
      throw new Error("Every request must be complete before archiving.");
    await removeRequestFolders(item.requests, true);
    await prisma.managedCase.update({
      where: { id: caseId },
      data: { status: "archived", archived_at: new Date() },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to archive case.",
      },
      { status: 400 },
    );
  }
}
