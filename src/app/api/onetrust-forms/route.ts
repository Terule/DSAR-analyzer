import { NextResponse } from "next/server";
import { encryptSetting } from "@/lib/credentials";
import {
  formColumns,
  type OneTrustFormInput,
  publicForm,
} from "@/lib/onetrust-forms";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Lists saved web forms. The API token is never returned. */
export async function GET() {
  const forms = await prisma.oneTrustForm.findMany({
    orderBy: { created_at: "asc" },
  });
  return NextResponse.json({ forms: forms.map(publicForm) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as OneTrustFormInput;
  const columns = formColumns(body);
  const apiToken = body.apiToken?.trim();
  if (!columns.name || !columns.template_id || !apiToken) {
    return NextResponse.json(
      { error: "Name, ID and token are required." },
      { status: 400 },
    );
  }
  const form = await prisma.oneTrustForm.create({
    data: { ...columns, api_token_encrypted: await encryptSetting(apiToken) },
  });
  return NextResponse.json({ form: publicForm(form) });
}
