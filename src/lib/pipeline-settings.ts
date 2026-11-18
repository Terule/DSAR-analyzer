import {
  REREVIEW_DEFAULT_MIN_P_KEEP,
  REREVIEW_DEFAULT_SAMPLE_PERCENT,
} from "./bedrock/config";
import {
  FILES_CONCURRENCY_LIMITS,
  isValidFilesConcurrency,
} from "./files-concurrency";
import { prisma } from "./prisma";

export const FIXED_STAGING_ROOT = "/data/Staging";
export const FIXED_DELIVERABLES_ROOT = "/data/Results";

export interface AiBatchSettings {
  sharePointSiteUrl: string;
  sharePointFolderId: string;
  sharePointFolderPath: string;
  stagingRoot?: string;
  deliverablesRoot?: string;
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
  deleteSourcePsts?: boolean;
  filesConcurrency?: number;
  filesAiEnabled?: boolean;
  /** A Haiku 4.5 discard with at least this p_keep (0-100) gets a second opinion from Haiku 5.5. */
  rereviewMinPKeep?: number;
  /** Percent (0-100) of the other, confident discards that are also judged again as a control. */
  rereviewSamplePercent?: number;
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

  const rereviewMinPKeep =
    input.rereviewMinPKeep ?? REREVIEW_DEFAULT_MIN_P_KEEP;
  if (
    !Number.isInteger(rereviewMinPKeep) ||
    rereviewMinPKeep < 0 ||
    rereviewMinPKeep > 100
  ) {
    throw new Error(
      "Second-review threshold must be a whole number from 0 to 100.",
    );
  }
  const rereviewSamplePercent =
    input.rereviewSamplePercent ?? REREVIEW_DEFAULT_SAMPLE_PERCENT;
  if (
    !Number.isFinite(rereviewSamplePercent) ||
    rereviewSamplePercent < 0 ||
    rereviewSamplePercent > 100
  ) {
    throw new Error(
      "Second-review control sample must be from 0 to 100 percent.",
    );
  }
  const filesConcurrency =
    input.filesConcurrency ?? FILES_CONCURRENCY_LIMITS.default;
  if (!isValidFilesConcurrency(filesConcurrency)) {
    throw new Error(
      `Files workers must be a whole number between ${FILES_CONCURRENCY_LIMITS.min} and ${FILES_CONCURRENCY_LIMITS.max}.`,
    );
  }

  return {
    sharePointSiteUrl,
    sharePointFolderId,
    sharePointFolderPath,
    stagingRoot: FIXED_STAGING_ROOT,
    deliverablesRoot: FIXED_DELIVERABLES_ROOT,
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
    deleteSourcePsts: input.deleteSourcePsts ?? true,
    filesConcurrency,
    filesAiEnabled: input.filesAiEnabled ?? true,
    rereviewMinPKeep,
    rereviewSamplePercent,
  };
}

export async function getAiBatchSettings(): Promise<AiBatchSettings> {
  const row = await prisma.pipelineSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
    },
    update: {},
  });
  return {
    sharePointSiteUrl: row.sharepoint_site_url || "",
    sharePointFolderId: row.sharepoint_folder_id || "",
    sharePointFolderPath: row.sharepoint_folder_path || "",
    stagingRoot: FIXED_STAGING_ROOT,
    deliverablesRoot: FIXED_DELIVERABLES_ROOT,
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
    deleteSourcePsts: row.delete_source_psts,
    filesConcurrency: row.files_concurrency,
    filesAiEnabled: row.files_ai_enabled,
    rereviewMinPKeep: row.rereview_min_p_keep,
    rereviewSamplePercent: row.rereview_sample_percent,
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
      delete_source_psts: settings.deleteSourcePsts ?? true,
      files_concurrency: settings.filesConcurrency,
      files_ai_enabled: settings.filesAiEnabled ?? true,
      rereview_min_p_keep: settings.rereviewMinPKeep,
      rereview_sample_percent: settings.rereviewSamplePercent,
    },
    update: {
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
      delete_source_psts: settings.deleteSourcePsts ?? true,
      files_concurrency: settings.filesConcurrency,
      files_ai_enabled: settings.filesAiEnabled ?? true,
      rereview_min_p_keep: settings.rereviewMinPKeep,
      rereview_sample_percent: settings.rereviewSamplePercent,
    },
  });
  return {
    sharePointSiteUrl: row.sharepoint_site_url || "",
    sharePointFolderId: row.sharepoint_folder_id || "",
    sharePointFolderPath: row.sharepoint_folder_path || "",
    stagingRoot: FIXED_STAGING_ROOT,
    deliverablesRoot: FIXED_DELIVERABLES_ROOT,
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
    deleteSourcePsts: row.delete_source_psts,
    filesConcurrency: row.files_concurrency,
    filesAiEnabled: row.files_ai_enabled,
    rereviewMinPKeep: row.rereview_min_p_keep,
    rereviewSamplePercent: row.rereview_sample_percent,
  };
}
