import { db } from "@/lib/db";
import { backfillMissingFileSizes, syncStagingArea } from "@/lib/staging";

interface StagedFile {
  id: string;
  filename: string;
  filepath: string;
  file_size_bytes: number;
  status: string;
  total_emails: number;
  total_attachments: number;
  unique_emails: number;
  duplicate_emails: number;
  created_at: string;
}

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const shouldSync = searchParams.get("sync") === "true";

    if (shouldSync) {
      // Executa a sincronização em background
      syncStagingArea().catch((err) =>
        console.error("Background sync error:", err),
      );

      return new Response(
        JSON.stringify({ success: true, message: "Sync started" }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    await backfillMissingFileSizes();

    // Otimização: SELECT apenas os campos necessários e limitando a carga inicial
    // Adicionamos um limite para evitar sobrecarga no carregamento da página
    const files = db
      .prepare(`
      SELECT * FROM processed_files 
      ORDER BY created_at DESC 
      LIMIT 100
    `)
      .all() as StagedFile[];

    return new Response(JSON.stringify({ success: true, data: files }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    console.error("Failed to fetch files:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to fetch files" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
