import { NextResponse } from "next/server";
import { listCaseHistory } from "@/lib/history";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const caseKey = searchParams.get("caseKey") || undefined;
    const limitRaw = searchParams.get("limit");
    const offsetRaw = searchParams.get("offset");

    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const parsedOffset = offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined;

    const { items, total, limit, offset } = await listCaseHistory({
      caseKey,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
    });

    return NextResponse.json(
      { success: true, data: items, total, limit, offset },
      {
        status: 200,
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      },
    );
  } catch (error) {
    console.error("Failed to fetch run history:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch run history" },
      { status: 500 },
    );
  }
}
