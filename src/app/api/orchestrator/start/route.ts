import path from "node:path";
import { NextResponse } from "next/server";
import { getCasePstFileIds } from "@/lib/case-utils";
import {
  findOtherAdmittedCase,
  withCaseStartLock,
} from "@/lib/control-plane/job-store";
import { enqueueFilePhase } from "@/lib/control-plane/pipeline";
import { ensureControlPlaneSchema } from "@/lib/control-plane/schema";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface StartBody {
  fileId: string;
  subjectCriteria: {
    name: string;
    email: string;
    personalEmail?: string;
    aliases?: string[];
  };
}

function caseKeyForPath(filepath: string | null): string {
  const stagingPath = process.env.STAGING_PATH || "";
  const relative =
    filepath && stagingPath ? path.relative(stagingPath, filepath) : "";
  const parts = relative
    .split(path.sep)
    .filter((part) => part && part !== "..");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] || "unknown";
}

/** Starts an entire case; all later phase transitions are backend-owned. */
export async function POST(request: Request) {
  try {
    const { fileId, subjectCriteria } = (await request.json()) as StartBody;
    if (!fileId || !subjectCriteria?.name || !subjectCriteria.email) {
      return NextResponse.json(
        {
          success: false,
          error: "fileId, subject name, and subject email are required.",
        },
        { status: 400 },
      );
    }
    await ensureControlPlaneSchema();
    const response = await withCaseStartLock(async () => {
      const ids = await getCasePstFileIds(fileId);
      const rows = await prisma.processedFile.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, filepath: true },
      });
      if (rows.length === 0) {
        return {
          status: 404,
          body: { success: false, error: "Case file was not found." },
        };
      }
      const caseKey = caseKeyForPath(rows[0]?.filepath ?? null);
      const blockingCase = await findOtherAdmittedCase(caseKey);
      if (blockingCase) {
        return {
          status: 409,
          body: {
            success: false,
            error: `Case ${blockingCase} is already running. Wait for it to finish before starting another case.`,
          },
        };
      }
      if (rows.some((row) => row.status !== "pending")) {
        return {
          status: 409,
          body: {
            success: false,
            error: "Every PST in the case must be pending before it can start.",
          },
        };
      }
      await prisma.$transaction(
        rows.map((row) =>
          prisma.processedFile.update({
            where: { id: row.id },
            data: {
              status: "scanning_metadata",
              subject_name: subjectCriteria.name,
              subject_email: subjectCriteria.email,
              subject_personal_email: subjectCriteria.personalEmail ?? null,
              subject_aliases: (subjectCriteria.aliases || []).join(", "),
            },
          }),
        ),
      );
      const jobIds = await Promise.all(
        rows.map((row) => enqueueFilePhase({ fileId: row.id, phase: "parse" })),
      );
      return { status: 202, body: { success: true, jobIds } };
    });
    return NextResponse.json(response.body, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unable to start case.",
      },
      { status: 500 },
    );
  }
}
