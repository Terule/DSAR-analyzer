import { NextResponse } from "next/server";
import { encryptSetting } from "@/lib/credentials";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Lists saved web forms. The API token is never returned. */
export async function GET() {
  const forms = await prisma.oneTrustForm.findMany({
    orderBy: { created_at: "asc" },
    select: { id: true, name: true, template_id: true },
  });
  return NextResponse.json({
    forms: forms.map((form) => ({
      id: form.id,
      name: form.name,
      templateId: form.template_id,
    })),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    templateId?: string;
    apiToken?: string;
  };
  const name = body.name?.trim();
  const templateId = body.templateId?.trim();
  const apiToken = body.apiToken?.trim();
  if (!name || !templateId || !apiToken) {
    return NextResponse.json(
      { error: "Name, ID and token are required." },
      { status: 400 },
    );
  }
  const form = await prisma.oneTrustForm.create({
    data: {
      name,
      template_id: templateId,
      api_token_encrypted: await encryptSetting(apiToken),
    },
  });
  return NextResponse.json({
    form: { id: form.id, name: form.name, templateId: form.template_id },
  });
}
