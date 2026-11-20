import { NextResponse } from "next/server";
import {
  addScannedRequests,
  listInputFolders,
  scanInputFolder,
} from "@/lib/input-scan";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Scan failed." },
    { status: 400 },
  );
}

export async function GET(request: Request) {
  try {
    const folder = new URL(request.url).searchParams.get("folder");
    if (!folder)
      return NextResponse.json({ folders: await listInputFolders() });
    return NextResponse.json({ requests: await scanInputFolder(folder) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      folder?: string;
      caseType?: string;
    };
    return NextResponse.json(
      await addScannedRequests({
        folder: body.folder ?? "",
        caseType: body.caseType,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
