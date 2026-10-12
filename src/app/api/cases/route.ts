import { NextResponse } from "next/server";
import { createManagedCase, refreshRequestLifecycle } from "@/lib/cases";
import { getFilesAiState } from "@/lib/files-ai";
import { oneTrustRequestUrl } from "@/lib/onetrust-links";
import {
  extractPhaseStatus,
  parsePhaseStatus,
  renderPhaseStatus,
  renderProgress,
} from "@/lib/phase-status";
import { getAiBatchSettings } from "@/lib/pipeline-settings";
import { prisma } from "@/lib/prisma";
import { retryTargets } from "@/lib/retry-targets";

export const dynamic = "force-dynamic";

function phaseProgress(
  rows: Array<{
    kind: string;
    status: string;
    ai_status: string;
    ai_batches_total: number;
    ai_batches_done: number;
    pdf_status: string;
    pdf_total: number;
    pdf_processed: number;
    files_status: string;
    files_total: number;
    files_progress_handled: number;
    upload_status: string;
    upload_total: number;
    upload_uploaded: number;
  }>,
  filesAi?: { done: number; total: number },
) {
  const pstRows = rows.filter((row) => row.kind === "pst");
  const filesRow = rows.find((row) => row.kind === "files");
  const totalPst = pstRows.length;
  const parsed = pstRows.filter((row) =>
    ["analyzed", "extracting", "completed"].includes(row.status),
  ).length;
  const extracted = pstRows.filter((row) => row.status === "completed").length;
  // Only the deterministic coordinator row owns live Batch counters. Sibling
  // PST rows remain `pending` while it works, so lexical status ordering can
  // incorrectly select a sibling and make a nearly-complete audit look idle.
  const coordinator = [...pstRows].sort(
    (left, right) =>
      right.ai_batches_total - left.ai_batches_total ||
      right.ai_batches_done - left.ai_batches_done,
  )[0];
  const render = renderProgress(pstRows);
  // A case can have several source rows, but only rows with an upload total
  // own deliverables. Sibling PSTs that never queued anything keep a default
  // `pending`/`idle` status with a zero total; counting them would stop the
  // request from ever reading as completed (stuck at 99%). A zero-total row
  // only matters while it is actively uploading or after it failed.
  const uploadRows = rows.filter(
    (row) =>
      row.upload_total > 0 ||
      row.upload_status === "processing" ||
      row.upload_status === "failed",
  );
  const uploadTotal = uploadRows.reduce(
    (count, row) => count + row.upload_total,
    0,
  );
  const uploadDone = uploadRows.reduce(
    (count, row) => count + Math.min(row.upload_uploaded, row.upload_total),
    0,
  );
  const uploadStatus =
    uploadRows.length === 0
      ? "pending"
      : uploadRows.every((row) => row.upload_status === "completed")
        ? "completed"
        : uploadRows.some((row) => row.upload_status === "failed")
          ? "failed"
          : uploadRows.some((row) => row.upload_status === "processing")
            ? "processing"
            : "pending";
  return {
    parse: {
      done: parsed,
      total: totalPst,
      status: parsePhaseStatus(pstRows),
    },
    extract: {
      done: extracted,
      total: totalPst,
      status: extractPhaseStatus(pstRows),
    },
    ai: {
      done: coordinator?.ai_batches_done || 0,
      total: coordinator?.ai_batches_total || 0,
      status: coordinator?.ai_status || "pending",
    },
    render: {
      done: render.done,
      total: render.total,
      status: renderPhaseStatus(pstRows),
    },
    files: {
      done: filesRow?.files_progress_handled || 0,
      total: filesRow?.files_total || 0,
      status: filesRow?.files_status || "pending",
      ...(filesAi && filesAi.total > 0 ? { ai: filesAi } : {}),
    },
    upload: {
      done: uploadDone,
      total: uploadTotal,
      status: uploadStatus,
    },
  };
}

function phaseTiming(
  rows: Array<{
    metadata_duration_ms: number;
    analyze_duration_ms: number;
    extract_duration_ms: number;
    ai_duration_ms: number;
    pdf_duration_ms: number;
    files_duration_ms: number;
    files_paused_ms: number;
  }>,
) {
  return rows.reduce(
    (total, row) => ({
      parse: total.parse + row.metadata_duration_ms + row.analyze_duration_ms,
      extract: total.extract + row.extract_duration_ms,
      ai: total.ai + row.ai_duration_ms,
      render: total.render + row.pdf_duration_ms,
      files:
        total.files + Math.max(0, row.files_duration_ms - row.files_paused_ms),
    }),
    { parse: 0, extract: 0, ai: 0, render: 0, files: 0 },
  );
}

export async function GET(request: Request) {
  await refreshRequestLifecycle();
  const settings = await getAiBatchSettings();
  const archived =
    new URL(request.url).searchParams.get("status") === "archived";
  const cases = await prisma.managedCase.findMany({
    where: { status: archived ? "archived" : "active" },
    include: {
      onetrust_upload_artifacts: { select: { status: true } },
      requests: {
        orderBy: { created_at: "asc" },
        include: {
          processed_files: {
            select: {
              id: true,
              kind: true,
              status: true,
              ai_status: true,
              ai_batches_total: true,
              ai_batches_done: true,
              pdf_status: true,
              pdf_total: true,
              pdf_processed: true,
              files_status: true,
              files_total: true,
              files_progress_handled: true,
              upload_status: true,
              upload_total: true,
              upload_uploaded: true,
              metadata_duration_ms: true,
              analyze_duration_ms: true,
              extract_duration_ms: true,
              ai_duration_ms: true,
              pdf_duration_ms: true,
              files_duration_ms: true,
              files_paused_ms: true,
              wave: true,
            },
          },
        },
      },
    },
    orderBy: { created_at: "desc" },
  });
  const filesRowIds = cases.flatMap((item) =>
    item.requests.flatMap((request) =>
      request.processed_files
        .filter((file) => file.kind === "files")
        .map((file) => file.id),
    ),
  );
  const filesAiById = new Map(
    await Promise.all(
      filesRowIds.map(async (id) => {
        const state = await getFilesAiState(id);
        return [id, { done: state.resolved, total: state.total }] as const;
      }),
    ),
  );
  return NextResponse.json({
    cases: cases.map(({ onetrust_upload_artifacts, ...item }) => ({
      ...item,
      onetrust_uploaded: onetrust_upload_artifacts.filter(
        (file) => file.status === "completed",
      ).length,
      onetrust_total: onetrust_upload_artifacts.length,
      onetrust_url:
        item.onetrust_request_id && settings.oneTrustTenantUrl
          ? oneTrustRequestUrl(
              settings.oneTrustTenantUrl,
              item.onetrust_request_id,
            )
          : null,
      requests: item.requests.map(({ processed_files, ...request }) => {
        // Phase cards describe the wave that is running; earlier waves are
        // finished and only contribute to the cumulative header totals.
        const currentWave = processed_files.filter(
          (file) => file.wave === request.wave,
        );
        return {
          ...request,
          case_type: item.case_type,
          pst_size_bytes: Number(request.pst_size_bytes),
          files_size_bytes: Number(request.files_size_bytes),
          deliverable_size_bytes: Number(request.deliverable_size_bytes),
          phaseProgress: phaseProgress(
            currentWave,
            filesAiById.get(
              currentWave.find((file) => file.kind === "files")?.id ?? "",
            ),
          ),
          phaseTiming: phaseTiming(currentWave),
          // Rows the dashboard's Retry re-runs: the failed steps of this wave.
          retryTargets: retryTargets(currentWave),
        };
      }),
    })),
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const created = await createManagedCase(body);
    return NextResponse.json({ case: created }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to create case.",
      },
      { status: 400 },
    );
  }
}
