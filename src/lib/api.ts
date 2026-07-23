import type { AiConfig, CaseHistoryResponse } from "@/lib/types";

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

export async function startCase(
  fileId: string,
  subjectCriteria: AiConfig,
): Promise<void> {
  const res = await postJson("/api/orchestrator/start", {
    fileId,
    subjectCriteria,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to start case pipeline.");
  }
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
  const res = await postJson("/api/filter", { fileId, subjectCriteria });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to start AI audit.");
  }
}

export async function resumeAiAudit(
  fileId: string,
): Promise<{ remaining: number }> {
  const res = await postJson("/api/ai-resume", { fileId });
  const data = (await res.json().catch(() => ({}))) as {
    remaining?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || "Failed to resume AI audit.");
  return { remaining: data.remaining || 0 };
}

export async function convertToPdf(fileId: string): Promise<void> {
  const res = await postJson("/api/convert", { fileId });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to start PDF conversion.");
  }
}

export interface BatchPollResult {
  status: string;
}

export interface AiBatchSettings {
  maxTokensPerBatch: number;
  maxConcurrentBatches: number;
}

export interface AiBatchSettingsLimits {
  minTokensPerBatch: number;
  maxTokensPerBatch: number;
  minConcurrentBatches: number;
  maxConcurrentBatches: number;
  maxQueuedTokens: number;
}

export async function getPipelineSettings(): Promise<{
  settings: AiBatchSettings;
  limits: AiBatchSettingsLimits;
}> {
  const res = await fetch("/api/settings", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load pipeline settings.");
  return res.json();
}

export async function updatePipelineSettings(
  settings: AiBatchSettings,
): Promise<AiBatchSettings> {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(settings),
  });
  const data = (await res.json().catch(() => ({}))) as {
    settings?: AiBatchSettings;
    error?: string;
  };
  if (!res.ok || !data.settings)
    throw new Error(data.error || "Failed to save pipeline settings.");
  return data.settings;
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

export async function prepareUpload(
  fileIds: string[],
): Promise<{ removed: number }> {
  const res = await postJson("/api/prepare-upload", { fileIds });
  const data = (await res.json().catch(() => ({}))) as {
    removed?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || "Failed to prepare upload.");
  return { removed: data.removed || 0 };
}

export async function processFiles(
  fileId: string,
  subjectCriteria: AiConfig,
): Promise<void> {
  const res = await postJson("/api/files-process", { fileId, subjectCriteria });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to start Files processing.");
  }
}

export async function fetchRunHistory(params?: {
  caseKey?: string;
  limit?: number;
  offset?: number;
}): Promise<CaseHistoryResponse> {
  const query = new URLSearchParams();
  if (params?.caseKey) query.set("caseKey", params.caseKey);
  if (typeof params?.limit === "number")
    query.set("limit", String(params.limit));
  if (typeof params?.offset === "number")
    query.set("offset", String(params.offset));

  const suffix = query.toString();
  const url = suffix ? `/api/history?${suffix}` : "/api/history";

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to fetch run history.");
  }
  const payload = (await res.json()) as {
    success: boolean;
    data: CaseHistoryResponse["data"];
    total: number;
    limit: number;
    offset: number;
  };

  return {
    data: payload.data,
    total: payload.total,
    limit: payload.limit,
    offset: payload.offset,
  };
}
