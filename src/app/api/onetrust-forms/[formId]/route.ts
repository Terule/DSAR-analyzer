import { NextResponse } from "next/server";
import { encryptSetting } from "@/lib/credentials";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Updates a web form. An empty token keeps the saved one. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ formId: string }> },
) {
  const { formId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    templateId?: string;
    apiToken?: string;
  };
  const name = body.name?.trim();
  const templateId = body.templateId?.trim();
  const apiToken = body.apiToken?.trim();
  if (!name || !templateId) {
    return NextResponse.json(
      { error: "Name and ID are required." },
      { status: 400 },
    );
  }
  const result = await prisma.oneTrustForm.updateMany({
    where: { id: formId },
    data: {
      name,
      template_id: templateId,
      ...(apiToken
        ? { api_token_encrypted: await encryptSetting(apiToken) }
        : {}),
    },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "Form not found." }, { status: 404 });
  }
  return NextResponse.json({ form: { id: formId, name, templateId } });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ formId: string }> },
) {
  const { formId } = await context.params;
  await prisma.oneTrustForm.deleteMany({ where: { id: formId } });
  return NextResponse.json({ success: true });
}
