import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
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
