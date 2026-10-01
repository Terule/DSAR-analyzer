import { NextResponse } from "next/server";
import { sendCaseToOneTrust } from "@/lib/onetrust";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    return NextResponse.json({
      success: true,
      ...(await sendCaseToOneTrust(caseId)),
    });
  } catch (error) {
    const { caseId } = await context.params;
    const message =
      error instanceof Error
        ? error.message
        : "Could not send case to OneTrust.";
    // A public web-form submission can be accepted before OneTrust's
    // authenticated API exposes its request reference. That is pending work,
    // not a failed submission, and must remain retry-safe.
    // Concurrency-guard rejections must not touch the status: the in-flight
    // run owns it, and overwriting it would release the lock.
    const isPending = message.startsWith("OneTrust accepted the request");
    const isGuard =
      message.includes("already in progress") ||
      message.includes("already being created");
    if (!isPending && !isGuard) {
      await prisma.managedCase
        .update({
          where: { id: caseId },
          data: { onetrust_status: "failed", onetrust_error: message },
        })
        .catch(() => undefined);
    }
    return NextResponse.json(
      {
        error: message,
      },
      { status: 400 },
    );
  }
}
