import { ensureBatchPollerRunning } from "@/lib/batch-scheduler";
import { isControlPlanePipelineEnabled } from "@/lib/control-plane/pipeline";
import { prisma } from "@/lib/prisma";
import { serializeProcessedFile } from "@/lib/serialize";
import { startSharePointArtifactWorker } from "@/lib/sharepoint-artifact-queue";

export const dynamic = "force-dynamic";

async function resumeSharePointUploads(): Promise<void> {
  const staleBefore = BigInt(Date.now() - 60_000);
  // Old client runs may have been queued before client cases became
  // deduplication-only. Clear their misleading upload state on reconnect.
  await prisma.processedFile.updateMany({
    where: {
      case_request: { case: { case_type: "client" } },
      upload_status: { not: "idle" },
    },
    data: {
      upload_status: "idle",
      upload_total: 0,
      upload_uploaded: 0,
      upload_error: null,
    },
  });
  await prisma.sharePointUploadArtifact.updateMany({
    where: {
      status: "processing",
      source_file: {
        case_request: { case: { case_type: "employee" } },
        OR: [
          { kind: "pst", pdf_status: "completed" },
          { kind: "files", files_status: "completed" },
        ],
      },
      OR: [{ heartbeat_at: null }, { heartbeat_at: { lt: staleBefore } }],
    },
    data: { status: "pending" },
  });
  const pendingArtifacts = await prisma.sharePointUploadArtifact.count({
    where: {
      status: "pending",
      source_file: {
        case_request: { case: { case_type: "employee" } },
      },
    },
  });
  if (pendingArtifacts > 0) startSharePointArtifactWorker();
}

export async function GET(req: Request) {
  await resumeSharePointUploads();
  // If the server restarted while an AI/render phase was mid-flight, resume the
  // poller as soon as a dashboard reconnects so batches keep getting synced, a
  // render orphaned in 'processing' gets reclaimed, and a Files phase whose case
  // already rendered gets started headlessly.
  const hasPendingAiWork = await prisma.processedFile.findFirst({
    where: {
      OR: [
        { ai_status: { in: ["processing", "batch_ready"] } },
        {
          ai_status: "completed",
          pdf_status: { in: ["pending", "processing"] },
        },
        {
          kind: "files",
          files_status: "pending",
          // At least one pst row must have completed rendering.
        },
      ],
    },
    select: { id: true },
  });
  let filesPhaseReady = false;
  if (!hasPendingAiWork) {
    const pendingFilesRow = await prisma.processedFile.findFirst({
      where: { kind: "files", files_status: "pending" },
      select: { id: true },
    });
    if (pendingFilesRow) {
      const renderedPst = await prisma.processedFile.findFirst({
        where: { kind: "pst", pdf_status: "completed" },
        select: { id: true },
      });
      filesPhaseReady = Boolean(renderedPst);
    }
  }
  // In the Docker control-plane the dispatcher is the sole Batch poller.
  // Starting a second app-server poller can apply a completed Batch twice.
  if (!isControlPlanePipelineEnabled() && (hasPendingAiWork || filesPhaseReady))
    ensureBatchPollerRunning();

  let closeStream: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let lastSnapshot = "";
      let closed = false;
      let sending = false;
      let interval: ReturnType<typeof setInterval> | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        try {
          controller.close();
        } catch {
          // A client can cancel the stream before its abort event is delivered.
        }
      };
      closeStream = close;

      // Queries may still be resolving when the browser disconnects. Guard both
      // sides of the async work so a normal SSE reconnect never enqueues into a
      // controller that has already been closed.
      const sendUpdate = async () => {
        if (closed || sending) return;
        sending = true;
        try {
          const files = await prisma.processedFile.findMany({
            orderBy: { created_at: "desc" },
          });
          if (closed) return;
          const pstIds = files
            .filter((file) => file.kind === "pst")
            .map((file) => file.id);
          const audited =
            pstIds.length > 0
              ? await prisma.email.groupBy({
                  by: ["file_id"],
                  where: {
                    file_id: { in: pstIds },
                    is_duplicate: 0,
                    ai_decision: { not: null },
                  },
                  _count: { _all: true },
                })
              : [];
          if (closed) return;
          const auditedByFile = new Map(
            audited.map((row) => [row.file_id, row._count._all]),
          );
          const snapshot = JSON.stringify(
            files.map((file) => ({
              ...serializeProcessedFile(file),
              ai_audited_count: auditedByFile.get(file.id) || 0,
            })),
          );

          if (closed || snapshot === lastSnapshot) return;

          lastSnapshot = snapshot;
          controller.enqueue(encoder.encode(`data: ${snapshot}\n\n`));
        } catch (err: unknown) {
          // Closing a stream while its database read is in flight is expected.
          if (!closed) console.error("SSE Streaming error:", err);
        } finally {
          sending = false;
        }
      };

      // Envia o estado inicial assim que conecta
      void sendUpdate();

      // Fica empurrando atualizações a cada 1.5 segundos
      interval = setInterval(() => void sendUpdate(), 1500);

      // Quando o usuário fecha a aba, encerramos o loop silenciosamente
      req.signal.addEventListener("abort", close, { once: true });
      if (req.signal.aborted) close();
    },
    cancel() {
      closeStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream", // Transforma a rota em um fluxo contínuo
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
