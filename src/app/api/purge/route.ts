import { purgePstDuplicates } from "../../../lib/purger";

export async function POST(request: Request) {
  try {
    const { fileId } = await request.json();

    if (!fileId || typeof fileId !== "string") {
      return new Response(
        JSON.stringify({ success: false, error: "fileId is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // We run this without 'await' to let it process in the background!
    purgePstDuplicates(fileId).catch((err: unknown) => console.error(err));

    return new Response(
      JSON.stringify({ success: true, message: "Purge started" }),
      {
        status: 202,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (_error) {
    return new Response(
      JSON.stringify({ success: false, error: "Failed to start purge" }),
      { status: 500 },
    );
  }
}
