import { NextResponse } from "next/server";
import { scanRequestSources } from "@/lib/cases";
import { enqueueFilePhase } from "@/lib/control-plane/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await context.params;
    const { request, sources } = await scanRequestSources(requestId);
    const sourceIds = sources.map((source) => source.id);
    await prisma.$transaction([
      prisma.processedFile.updateMany({
        where: { id: { in: sourceIds } },
        data: {
          subject_name: request.case.subject_name,
          subject_email: request.case.subject_email,
          subject_personal_email: request.case.subject_personal_email,
          subject_aliases: request.case.subject_aliases,
        },
      }),
      prisma.processedFile.updateMany({
        where: { id: { in: sourceIds }, kind: "pst" },
        data: { status: "scanning_metadata" },
      }),
      prisma.caseRequest.update({
        where: { id: requestId },
        data: { status: "running", started_at: new Date() },
      }),
    ]);
    const admittedSources = sources.filter(
      (source) => source.kind === "pst" || request.scope === "files",
    );
    await Promise.all(
      admittedSources.map((source) =>
        enqueueFilePhase({
          fileId: source.id,
          phase: source.kind === "files" ? "files" : "parse",
        }),
      ),
    );
    return NextResponse.json(
      { success: true, queued: admittedSources.length },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to run request.",
      },
      { status: 400 },
    );
  }
}
