import { NextResponse } from "next/server";
import { restoreCaseByName } from "@/lib/case-restore";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  try {
    const restored = await restoreCaseByName(body.name ?? "");
    return NextResponse.json({ success: true, case: restored });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to restore case.",
      },
      { status: 400 },
    );
  }
}
