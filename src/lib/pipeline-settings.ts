import { prisma } from "./prisma";

export const DEFAULT_AI_BATCH_SETTINGS = {
  maxTokensPerBatch: 2_000_000,
  maxConcurrentBatches: 4,
} as const;

export const FIXED_STAGING_ROOT = "/data/Staging";
export const FIXED_DELIVERABLES_ROOT = "/data/Results";

export const AI_BATCH_SETTINGS_LIMITS = {
  minTokensPerBatch: 250_000,
  maxTokensPerBatch: 4_000_000,
  minConcurrentBatches: 1,
  maxConcurrentBatches: 12,
  maxQueuedTokens: 20_000_000,
} as const;

export interface AiBatchSettings {
  maxTokensPerBatch: number;
  maxConcurrentBatches: number;
  sharePointSiteUrl: string;
  sharePointFolderId: string;
  sharePointFolderPath: string;
  stagingRoot?: string;
  deliverablesRoot?: string;
  hasOpenAiKey?: boolean;
  hasAzureTenantId?: boolean;
  hasAzureClientId?: boolean;
  hasAzureClientSecret?: boolean;
  oneTrustTenantUrl: string;
  oneTrustTemplateId: string;
  oneTrustPublicWebFormUrl: string;
  oneTrustLanguage: string;
  oneTrustRequestType: string;
  oneTrustSubjectType: string;
  oneTrustDateRaisedFieldKey: string;
  oneTrustSystemLabel: string;
  hasOneTrustClientId?: boolean;
  hasOneTrustClientSecret?: boolean;
}

function normalizeOptionalUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const url = new URL(trimmed);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".sharepoint.com")) {
    throw new Error("SharePoint site must be an HTTPS sharepoint.com URL.");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeOneTrustUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = new URL(trimmed);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".onetrust.com")) {
    throw new Error("OneTrust tenant must be an HTTPS onetrust.com URL.");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateAiBatchSettings(
  input: AiBatchSettings,
): AiBatchSettings {
  const maxTokensPerBatch = Math.floor(input.maxTokensPerBatch);
  const maxConcurrentBatches = Math.floor(input.maxConcurrentBatches);
  const limits = AI_BATCH_SETTINGS_LIMITS;
  if (
    !Number.isFinite(maxTokensPerBatch) ||
    maxTokensPerBatch < limits.minTokensPerBatch ||
    maxTokensPerBatch > limits.maxTokensPerBatch
  ) {
    throw new Error(
      `Batch tokens must be between ${limits.minTokensPerBatch} and ${limits.maxTokensPerBatch}.`,
    );
  }
  if (
    !Number.isFinite(maxConcurrentBatches) ||
    maxConcurrentBatches < limits.minConcurrentBatches ||
    maxConcurrentBatches > limits.maxConcurrentBatches
  ) {
    throw new Error(
      `Parallel batches must be between ${limits.minConcurrentBatches} and ${limits.maxConcurrentBatches}.`,
    );
  }
  if (maxTokensPerBatch * maxConcurrentBatches > limits.maxQueuedTokens) {
    throw new Error(
      `Configured queued work must not exceed ${limits.maxQueuedTokens} tokens.`,
    );
  }
  const sharePointSiteUrl = normalizeOptionalUrl(input.sharePointSiteUrl || "");
  const sharePointFolderId = input.sharePointFolderId?.trim() || "";
  const sharePointFolderPath = input.sharePointFolderPath?.trim() || "";
  if ((sharePointFolderId || sharePointFolderPath) && !sharePointSiteUrl) {
    throw new Error("Configure a SharePoint site before selecting a folder.");
  }
  const oneTrustTenantUrl = normalizeOneTrustUrl(input.oneTrustTenantUrl || "");
  const oneTrustTemplateId = input.oneTrustTemplateId?.trim() || "";
  const oneTrustPublicWebFormUrl = normalizeOneTrustUrl(
    input.oneTrustPublicWebFormUrl || "",
  );
  const oneTrustLanguage = input.oneTrustLanguage?.trim() || "en-gb";
  const oneTrustRequestType = "RequestType3";
  const oneTrustSubjectType =
    input.oneTrustSubjectType?.trim() || "SubjectType3";
  const oneTrustDateRaisedFieldKey =
    input.oneTrustDateRaisedFieldKey?.trim() || "formField81";
  const oneTrustSystemLabel = input.oneTrustSystemLabel?.trim() || "AIDA";
  // Only user-supplied values count: request/subject type always have defaults.
  if (oneTrustTemplateId && !oneTrustTenantUrl) {
    throw new Error(
      "Configure a OneTrust tenant before saving OneTrust defaults.",
    );
  }

  return {
    maxTokensPerBatch,
    maxConcurrentBatches,
    sharePointSiteUrl,
    sharePointFolderId,
    sharePointFolderPath,
    stagingRoot: FIXED_STAGING_ROOT,
    deliverablesRoot: FIXED_DELIVERABLES_ROOT,
    hasOpenAiKey: input.hasOpenAiKey,
    hasAzureTenantId: input.hasAzureTenantId,
    hasAzureClientId: input.hasAzureClientId,
    hasAzureClientSecret: input.hasAzureClientSecret,
    oneTrustTenantUrl,
    oneTrustTemplateId,
    oneTrustPublicWebFormUrl,
    oneTrustLanguage,
    oneTrustRequestType,
    oneTrustSubjectType,
    oneTrustDateRaisedFieldKey,
    oneTrustSystemLabel,
    hasOneTrustClientId: input.hasOneTrustClientId,
    hasOneTrustClientSecret: input.hasOneTrustClientSecret,
  };
}

export async function getAiBatchSettings(): Promise<AiBatchSettings> {
  const row = await prisma.pipelineSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      ai_max_tokens_per_batch: DEFAULT_AI_BATCH_SETTINGS.maxTokensPerBatch,
      ai_max_concurrent_batches: DEFAULT_AI_BATCH_SETTINGS.maxConcurrentBatches,
    },
    update: {},
  });
  return {
    maxTokensPerBatch: row.ai_max_tokens_per_batch,
    maxConcurrentBatches: row.ai_max_concurrent_batches,
    sharePointSiteUrl: row.sharepoint_site_url || "",
    sharePointFolderId: row.sharepoint_folder_id || "",
    sharePointFolderPath: row.sharepoint_folder_path || "",
    stagingRoot: FIXED_STAGING_ROOT,
    deliverablesRoot: FIXED_DELIVERABLES_ROOT,
    hasOpenAiKey: Boolean(row.openai_api_key_encrypted),
    hasAzureTenantId: Boolean(row.azure_tenant_id_encrypted),
    hasAzureClientId: Boolean(row.azure_client_id_encrypted),
    hasAzureClientSecret: Boolean(row.azure_client_secret_encrypted),
    oneTrustTenantUrl: row.onetrust_tenant_url || "",
    oneTrustTemplateId: row.onetrust_template_id || "",
    oneTrustPublicWebFormUrl: row.onetrust_public_webform_url || "",
    oneTrustLanguage: row.onetrust_language || "en-gb",
    oneTrustRequestType: "RequestType3",
    oneTrustSubjectType: row.onetrust_subject_type || "SubjectType3",
    oneTrustDateRaisedFieldKey:
      row.onetrust_date_raised_field_key || "formField81",
    oneTrustSystemLabel: row.onetrust_system_label || "AIDA",
    hasOneTrustClientId: Boolean(row.onetrust_client_id_encrypted),
    hasOneTrustClientSecret: Boolean(row.onetrust_client_secret_encrypted),
  };
}

export async function updateAiBatchSettings(
  input: AiBatchSettings,
): Promise<AiBatchSettings> {
  const settings = validateAiBatchSettings(input);
  const row = await prisma.pipelineSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      ai_max_tokens_per_batch: settings.maxTokensPerBatch,
      ai_max_concurrent_batches: settings.maxConcurrentBatches,
      sharepoint_site_url: settings.sharePointSiteUrl || null,
      sharepoint_folder_id: settings.sharePointFolderId || null,
      sharepoint_folder_path: settings.sharePointFolderPath || null,
      staging_root: settings.stagingRoot,
      deliverables_root: settings.deliverablesRoot,
      onetrust_tenant_url: settings.oneTrustTenantUrl || null,
      onetrust_template_id: settings.oneTrustTemplateId || null,
      onetrust_public_webform_url: settings.oneTrustPublicWebFormUrl || null,
      onetrust_language: settings.oneTrustLanguage,
      onetrust_request_type: settings.oneTrustRequestType || null,
      onetrust_subject_type: settings.oneTrustSubjectType || null,
      onetrust_date_raised_field_key:
        settings.oneTrustDateRaisedFieldKey || null,
      onetrust_system_label: settings.oneTrustSystemLabel,
    },
    update: {
      ai_max_tokens_per_batch: settings.maxTokensPerBatch,
      ai_max_concurrent_batches: settings.maxConcurrentBatches,
      sharepoint_site_url: settings.sharePointSiteUrl || null,
      sharepoint_folder_id: settings.sharePointFolderId || null,
      sharepoint_folder_path: settings.sharePointFolderPath || null,
      staging_root: settings.stagingRoot,
      deliverables_root: settings.deliverablesRoot,
      onetrust_tenant_url: settings.oneTrustTenantUrl || null,
      onetrust_template_id: settings.oneTrustTemplateId || null,
      onetrust_public_webform_url: settings.oneTrustPublicWebFormUrl || null,
      onetrust_language: settings.oneTrustLanguage,
      onetrust_request_type: settings.oneTrustRequestType || null,
      onetrust_subject_type: settings.oneTrustSubjectType || null,
      onetrust_date_raised_field_key:
        settings.oneTrustDateRaisedFieldKey || null,
      onetrust_system_label: settings.oneTrustSystemLabel,
    },
  });
  return {
    maxTokensPerBatch: row.ai_max_tokens_per_batch,
    maxConcurrentBatches: row.ai_max_concurrent_batches,
    sharePointSiteUrl: row.sharepoint_site_url || "",
    sharePointFolderId: row.sharepoint_folder_id || "",
    sharePointFolderPath: row.sharepoint_folder_path || "",
    stagingRoot: FIXED_STAGING_ROOT,
    deliverablesRoot: FIXED_DELIVERABLES_ROOT,
    hasOpenAiKey: Boolean(row.openai_api_key_encrypted),
    hasAzureTenantId: Boolean(row.azure_tenant_id_encrypted),
    hasAzureClientId: Boolean(row.azure_client_id_encrypted),
    hasAzureClientSecret: Boolean(row.azure_client_secret_encrypted),
    oneTrustTenantUrl: row.onetrust_tenant_url || "",
    oneTrustTemplateId: row.onetrust_template_id || "",
    oneTrustPublicWebFormUrl: row.onetrust_public_webform_url || "",
    oneTrustLanguage: row.onetrust_language || "en-gb",
    oneTrustRequestType: "RequestType3",
    oneTrustSubjectType: row.onetrust_subject_type || "SubjectType3",
    oneTrustDateRaisedFieldKey:
      row.onetrust_date_raised_field_key || "formField81",
    oneTrustSystemLabel: row.onetrust_system_label || "AIDA",
    hasOneTrustClientId: Boolean(row.onetrust_client_id_encrypted),
    hasOneTrustClientSecret: Boolean(row.onetrust_client_secret_encrypted),
  };
}
