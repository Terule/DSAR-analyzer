import { NextResponse } from "next/server";
import { RequestPendingError, sendCaseToOneTrust } from "@/lib/onetrust";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      formId?: unknown;
    };
    const formId =
      typeof body.formId === "string" && body.formId ? body.formId : undefined;
    return NextResponse.json({
      success: true,
      ...(await sendCaseToOneTrust(caseId, formId)),
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
    const isPending = error instanceof RequestPendingError;
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
