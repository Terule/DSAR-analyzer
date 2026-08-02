import { listSharePointFolderChildren } from "@/lib/sharepoint";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const parentId =
      new URL(request.url).searchParams.get("parentId") || undefined;
    const folders = await listSharePointFolderChildren(parentId);
    return Response.json({ folders });
  } catch (error) {
    console.error("[SharePoint folders] Failed:", error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not search SharePoint folders.",
      },
      { status: 400 },
    );
  }
}
