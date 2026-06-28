import type { AiConfig } from "@/lib/types";

const jsonHeaders = { "Content-Type": "application/json" };

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

export function scanDirectory(): Promise<Response> {
  return fetch("/api/files?sync=true", { cache: "no-store" });
}

export async function scanMetadata(fileId: string): Promise<void> {
  await postJson("/api/metadata", { fileId });
}

export async function analyzeFile(fileId: string): Promise<void> {
  await postJson("/api/analyze", { fileId });
}

export async function extractFile(fileId: string): Promise<void> {
  await postJson("/api/extract", { fileId });
}

export async function runAiAudit(
  fileId: string,
  subjectCriteria: AiConfig,
): Promise<void> {
  await postJson("/api/filter", { fileId, subjectCriteria });
}

export async function convertToPdf(fileId: string): Promise<void> {
  await postJson("/api/convert", { fileId });
}

export interface BatchPollResult {
  status: string;
}

export async function pollBatch(fileId: string): Promise<BatchPollResult> {
  const res = await postJson("/api/batch-poll", { fileId });
  return res.json();
}

export async function wipeCase(
  caseName: string,
  fileIds: string[],
): Promise<boolean> {
  const res = await postJson("/api/wipe", { caseName, fileIds });
  return res.ok;
}

export interface StandalonePayload {
  caseName: string;
  subjectCriteria: { name: string; aliases: string[] };
}

export interface StandaloneResponse {
  success?: boolean;
  processedCount?: number;
  skippedCount?: number;
  message?: string;
  error?: string;
}

export async function runStandalone(
  payload: StandalonePayload,
): Promise<{ ok: boolean; data: StandaloneResponse }> {
  const res = await postJson("/api/standalone", payload);
  const data: StandaloneResponse = await res.json();
  return { ok: res.ok, data };
}
