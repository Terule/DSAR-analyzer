import { NextResponse } from "next/server";
import { fillAiBatchSlots } from "@/lib/ai";
import { getCasePstFileIds } from "@/lib/case-utils";
import {
  AI_BATCH_SETTINGS_LIMITS,
  getAiBatchSettings,
  updateAiBatchSettings,
} from "@/lib/pipeline-settings";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getAiBatchSettings();
  return NextResponse.json({ settings, limits: AI_BATCH_SETTINGS_LIMITS });
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      maxTokensPerBatch?: number;
      maxConcurrentBatches?: number;
    };
    const settings = await updateAiBatchSettings({
      maxTokensPerBatch: Number(body.maxTokensPerBatch),
      maxConcurrentBatches: Number(body.maxConcurrentBatches),
    });

    // Raising the window should take effect now, rather than waiting for a
    // currently submitted Batch to finish. Existing accepted Batches remain
    // untouched; this only fills unoccupied slots.
    const activeRows = await prisma.processedFile.findMany({
      where: { kind: "pst", ai_status: { in: ["processing", "batch_ready"] } },
      select: {
        id: true,
        subject_name: true,
        subject_email: true,
        subject_personal_email: true,
        subject_aliases: true,
      },
    });
    const coordinators = new Set<string>();
    for (const row of activeRows) {
      const caseIds = await getCasePstFileIds(row.id);
      const coordinator = [...caseIds].sort()[0];
      if (!coordinator || coordinators.has(coordinator)) continue;
      coordinators.add(coordinator);
      await fillAiBatchSlots(coordinator, {
        name: row.subject_name || "",
        email: row.subject_email || "",
        personalEmail: row.subject_personal_email || undefined,
        aliases: row.subject_aliases
          ? row.subject_aliases
              .split(",")
              .map((alias) => alias.trim())
              .filter(Boolean)
          : [],
      });
    }

    return NextResponse.json({ success: true, settings });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Invalid settings.",
      },
      { status: 400 },
    );
  }
}
