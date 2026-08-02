import { NextResponse } from "next/server";
import { fillAiBatchSlots } from "@/lib/ai";
import { getCasePstFileIds } from "@/lib/case-utils";
import { encryptSetting } from "@/lib/credentials";
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
      sharePointSiteUrl?: string;
      sharePointFolderId?: string;
      sharePointFolderPath?: string;
      openAiKey?: string;
      azureTenantId?: string;
      azureClientId?: string;
      azureClientSecret?: string;
    };
    const settings = await updateAiBatchSettings({
      maxTokensPerBatch: Number(body.maxTokensPerBatch),
      maxConcurrentBatches: Number(body.maxConcurrentBatches),
      sharePointSiteUrl: body.sharePointSiteUrl || "",
      sharePointFolderId: body.sharePointFolderId || "",
      sharePointFolderPath: body.sharePointFolderPath || "",
    });
    const encrypted = await Promise.all([
      body.openAiKey?.trim()
        ? encryptSetting(body.openAiKey.trim())
        : undefined,
      body.azureTenantId?.trim()
        ? encryptSetting(body.azureTenantId.trim())
        : undefined,
      body.azureClientId?.trim()
        ? encryptSetting(body.azureClientId.trim())
        : undefined,
      body.azureClientSecret?.trim()
        ? encryptSetting(body.azureClientSecret.trim())
        : undefined,
    ]);
    if (encrypted.some(Boolean)) {
      await prisma.pipelineSettings.update({
        where: { id: "global" },
        data: {
          ...(encrypted[0] ? { openai_api_key_encrypted: encrypted[0] } : {}),
          ...(encrypted[1] ? { azure_tenant_id_encrypted: encrypted[1] } : {}),
          ...(encrypted[2] ? { azure_client_id_encrypted: encrypted[2] } : {}),
          ...(encrypted[3]
            ? { azure_client_secret_encrypted: encrypted[3] }
            : {}),
        },
      });
    }

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
