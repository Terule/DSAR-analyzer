import { NextResponse } from "next/server";
import { previewRequestUpload } from "@/lib/request-upload";
import { queueSharePointArtifacts } from "@/lib/sharepoint-artifact-outbox";
import { startSharePointArtifactWorker } from "@/lib/sharepoint-artifact-queue";

export const dynamic = "force-dynamic";

/** What a manual SharePoint upload of this request would send. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  const preview = await previewRequestUpload(requestId);
  if (!preview) {
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  }
  const { paths: _paths, fileId: _fileId, ...visible } = preview;
  return NextResponse.json(visible);
}

/** Queues the request's delivered files; files already uploaded are skipped. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  const preview = await previewRequestUpload(requestId);
  if (!preview) {
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  }
  if (preview.blocked || !preview.fileId) {
    return NextResponse.json(
      { error: preview.blocked ?? "Nothing to upload." },
      { status: 400 },
    );
  }
  try {
    const queued = await queueSharePointArtifacts(
      preview.fileId,
      preview.paths,
    );
    if (queued > 0) startSharePointArtifactWorker();
    return NextResponse.json({ success: true, queued }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not start the upload.",
      },
      { status: 500 },
    );
  }
}
