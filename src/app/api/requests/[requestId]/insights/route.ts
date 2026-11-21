import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buildActivity,
  buildFunnel,
  buildOutcomes,
} from "@/lib/request-insights";

export const dynamic = "force-dynamic";

/** Funnel, AI split, PST list and activity of one request, for the case screen. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  const request = await prisma.caseRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      started_at: true,
      completed_at: true,
      scope: true,
      case: { select: { case_type: true } },
      processed_files: {
        select: {
          id: true,
          kind: true,
          filename: true,
          filepath: true,
          file_size_bytes: true,
          total_emails: true,
          total_attachments: true,
          status: true,
          ai_status: true,
          pdf_status: true,
          files_status: true,
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
  });
  if (!request) {
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  }
  // Mail and files together; chat messages are children of a chat file and
  // attachments of an email, so only top-level items count as "received".
  const [groups, reanalysing, nestedEmails, nestedDuplicates] =
    await Promise.all([
      prisma.item.groupBy({
        by: ["state", "decision_rule", "origin"],
        where: {
          case_request_id: requestId,
          origin: { in: ["pst", "files_folder"] },
          kind: { not: "chat_message" },
        },
        _count: { _all: true },
      }),
      prisma.item.count({
        where: {
          kind: "email",
          rereview_status: "pending",
          case_request_id: requestId,
        },
      }),
      // Emails found inside attachments: judged like any email, but kept out of
      // the bars so those count what came in through the PSTs.
      prisma.item.count({
        where: {
          kind: "email",
          origin: "attachment",
          case_request_id: requestId,
        },
      }),
      prisma.item.count({
        where: {
          kind: "email",
          origin: "attachment",
          decision_rule: "dup",
          case_request_id: requestId,
        },
      }),
    ]);
  const funnel = buildFunnel(
    groups.map((group) => ({
      state: group.state,
      rule: group.decision_rule,
      count: group._count._all,
    })),
  );
  const outcomes = buildOutcomes(
    groups.map((group) => ({
      state: group.state,
      rule: group.decision_rule,
      count: group._count._all,
      kind:
        group.origin === "files_folder"
          ? ("files" as const)
          : ("emails" as const),
    })),
  );
  const pst = request.processed_files.filter((file) => file.kind === "pst");
  const sum = (
    key:
      | "metadata_duration_ms"
      | "analyze_duration_ms"
      | "extract_duration_ms"
      | "ai_duration_ms"
      | "pdf_duration_ms"
      | "files_duration_ms",
  ) => request.processed_files.reduce((total, file) => total + file[key], 0);
  const pstDone = (field: "status" | "ai_status" | "pdf_status") =>
    pst.length > 0 && pst.every((file) => file[field] === "completed");
  const activity = buildActivity({
    startedAt: request.started_at?.getTime() ?? null,
    readMs: sum("metadata_duration_ms") + sum("analyze_duration_ms"),
    prepareMs: sum("extract_duration_ms"),
    aiMs: sum("ai_duration_ms"),
    renderMs: sum("pdf_duration_ms"),
    filesMs: sum("files_duration_ms"),
    done: {
      read:
        pst.length > 0 &&
        pst.every((file) =>
          ["analyzed", "extracting", "completed"].includes(file.status),
        ),
      prepare: pstDone("status"),
      ai: pstDone("ai_status"),
      render: pstDone("pdf_status"),
      files: (() => {
        const rows = request.processed_files.filter(
          (file) => file.kind === "files",
        );
        return (
          rows.length > 0 &&
          rows.every((file) => file.files_status === "completed")
        );
      })(),
    },
    aiStarted: pst.some((file) => file.ai_status !== "pending"),
    reanalysing: reanalysing > 0,
    completedAt: request.completed_at?.getTime() ?? null,
    hasFiles: request.scope !== "mail",
  });
  return NextResponse.json({
    caseType: request.case.case_type,
    funnel,
    outcomes,
    nestedEmails,
    nestedDuplicates,
    reanalysing,
    pst: pst.map((file) => ({
      id: file.id,
      name: file.filename ?? "",
      // The folder the PST sits in (two PSTs of one request can share a name).
      folder:
        file.filepath?.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? "",
      emails: file.total_emails,
      attachments: file.total_attachments,
      sizeBytes: Number(file.file_size_bytes),
      status: file.status,
    })),
    activity,
  });
}
