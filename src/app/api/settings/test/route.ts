import {
  BedrockClient,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { NextResponse } from "next/server";
import { BEDROCK_REGION } from "@/lib/bedrock/config";
import { accessToken } from "@/lib/onetrust";
import { getAiBatchSettings } from "@/lib/pipeline-settings";
import { listSharePointFolderChildren } from "@/lib/sharepoint";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out after ${TIMEOUT_MS / 1000} s`)),
        TIMEOUT_MS,
      ),
    ),
  ]);
}

/**
 * "Test connection" of the settings screen. Each target makes the cheapest
 * call that proves the credentials work and sends no case data anywhere.
 */
export async function POST(request: Request) {
  const { target } = (await request.json().catch(() => ({}))) as {
    target?: string;
  };
  try {
    if (target === "sharepoint") {
      await withTimeout(listSharePointFolderChildren());
    } else if (target === "onetrust") {
      await withTimeout(accessToken(await getAiBatchSettings()));
    } else if (target === "bedrock") {
      await withTimeout(
        new BedrockClient({ region: BEDROCK_REGION }).send(
          new ListInferenceProfilesCommand({ maxResults: 1 }),
        ),
      );
    } else {
      return NextResponse.json({ error: "Unknown target." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Connection failed.",
    });
  }
}
