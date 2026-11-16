import { NextResponse } from "next/server";
import { encryptSetting } from "@/lib/credentials";
import {
  formColumns,
  type OneTrustFormInput,
  publicForm,
} from "@/lib/onetrust-forms";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Updates a web form. An empty token keeps the saved one. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ formId: string }> },
) {
  const { formId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as OneTrustFormInput;
  const columns = formColumns(body);
  const apiToken = body.apiToken?.trim();
  if (!columns.name || !columns.template_id) {
    return NextResponse.json(
      { error: "Name and ID are required." },
      { status: 400 },
    );
  }
  const result = await prisma.oneTrustForm.updateMany({
    where: { id: formId },
    data: {
      ...columns,
      ...(apiToken
        ? { api_token_encrypted: await encryptSetting(apiToken) }
        : {}),
    },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "Form not found." }, { status: 404 });
  }
  const form = await prisma.oneTrustForm.findUnique({ where: { id: formId } });
  return NextResponse.json({ form: form ? publicForm(form) : null });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ formId: string }> },
) {
  const { formId } = await context.params;
  await prisma.oneTrustForm.deleteMany({ where: { id: formId } });
  return NextResponse.json({ success: true });
}
