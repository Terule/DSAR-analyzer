import { NextResponse } from "next/server";
import { createManagedCase, refreshRequestLifecycle } from "@/lib/cases";
import { prisma } from "@/lib/prisma";

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
  }>,
) {
  const pstRows = rows.filter((row) => row.kind === "pst");
  const filesRow = rows.find((row) => row.kind === "files");
  const totalPst = pstRows.length;
  const parsed = pstRows.filter((row) =>
    ["analyzed", "extracting", "completed"].includes(row.status),
  ).length;
  const extracted = pstRows.filter((row) => row.status === "completed").length;
  const coordinator = [...pstRows].sort((a, b) =>
    a.ai_status.localeCompare(b.ai_status),
  )[0];
  const rendered = pstRows.filter(
    (row) => row.pdf_status === "completed",
  ).length;
  const renderTotal = pstRows.reduce(
    (count, row) => count + Math.max(row.pdf_total, 1),
    0,
  );
  const renderDone = pstRows.reduce(
    (count, row) =>
      count +
      (row.pdf_status === "completed"
        ? Math.max(row.pdf_total, 1)
        : row.pdf_processed),
    0,
  );
  return {
    parse: {
      done: parsed,
      total: totalPst,
      status: pstRows[0]?.status || "pending",
    },
    extract: {
      done: extracted,
      total: totalPst,
      status: pstRows[0]?.status || "pending",
    },
    ai: {
      done: coordinator?.ai_batches_done || 0,
      total: coordinator?.ai_batches_total || 0,
      status: coordinator?.ai_status || "pending",
    },
    render: {
      done: renderDone,
      total: renderTotal,
      status:
        rendered === totalPst && totalPst > 0
          ? "completed"
          : pstRows[0]?.pdf_status || "pending",
    },
    files: {
      done: filesRow?.files_progress_handled || 0,
      total: filesRow?.files_total || 0,
      status: filesRow?.files_status || "pending",
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
  const archived =
    new URL(request.url).searchParams.get("status") === "archived";
  const cases = await prisma.managedCase.findMany({
    where: { status: archived ? "archived" : "active" },
    include: {
      requests: {
        orderBy: { created_at: "asc" },
        include: {
          processed_files: {
            select: {
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
              metadata_duration_ms: true,
              analyze_duration_ms: true,
              extract_duration_ms: true,
              ai_duration_ms: true,
              pdf_duration_ms: true,
              files_duration_ms: true,
              files_paused_ms: true,
            },
          },
        },
      },
    },
    orderBy: { created_at: "desc" },
  });
  return NextResponse.json({
    cases: cases.map((item) => ({
      ...item,
      requests: item.requests.map(({ processed_files, ...request }) => ({
        ...request,
        pst_size_bytes: Number(request.pst_size_bytes),
        files_size_bytes: Number(request.files_size_bytes),
        deliverable_size_bytes: Number(request.deliverable_size_bytes),
        phaseProgress: phaseProgress(processed_files),
        phaseTiming: phaseTiming(processed_files),
      })),
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
