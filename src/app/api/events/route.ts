import { ensureBatchPollerRunning } from "@/lib/batch-scheduler";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // If the server restarted while an AI/render phase was mid-flight, resume the
  // poller as soon as a dashboard reconnects so batches keep getting synced, a
  // render orphaned in 'processing' gets reclaimed, and a Files phase whose case
  // already rendered gets started headlessly.
  const hasPendingAiWork = db
    .prepare(
      `SELECT 1 FROM processed_files
       WHERE ai_status IN ('processing', 'batch_ready')
          OR (ai_status = 'completed' AND pdf_status IN ('pending', 'processing'))
          OR (kind = 'files' AND files_status = 'pending'
              AND EXISTS (
                SELECT 1 FROM processed_files p2
                WHERE p2.kind = 'pst' AND p2.pdf_status = 'completed'
              ))
       LIMIT 1`,
    )
    .get();
  if (hasPendingAiWork) ensureBatchPollerRunning();

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let lastSnapshot = "";

      // Função que envia o estado do banco para o frontend
      const sendUpdate = () => {
        try {
          const files = db
            .prepare("SELECT * FROM processed_files ORDER BY created_at DESC")
            .all();
          const snapshot = JSON.stringify(files);

          if (snapshot === lastSnapshot) return;

          lastSnapshot = snapshot;
          controller.enqueue(encoder.encode(`data: ${snapshot}\n\n`));
        } catch (err: unknown) {
          console.error("SSE Streaming error:", err);
        }
      };

      // Envia o estado inicial assim que conecta
      sendUpdate();

      // Fica empurrando atualizações a cada 1.5 segundos
      const interval = setInterval(sendUpdate, 1500);

      // Quando o usuário fecha a aba, encerramos o loop silenciosamente
      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
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
