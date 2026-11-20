import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { decryptSetting, runtimeCredentials } from "./credentials";
import {
  isOneTrustDeliverablePath,
  renumberDeliverables,
} from "./deliverable-sequence";
import {
  attachedFileIds,
  type EmailAttachmentMetadata,
  emailMetadata,
  emailNumberFromPath,
  ledgerHashesByNumber,
  MAX_RATE_LIMIT_RETRIES,
  resultSummaryBody,
  resultSummaryPath,
  retryDelayMs,
} from "./onetrust-attachments";
import { getAiBatchSettings } from "./pipeline-settings";
import { prisma } from "./prisma";

const MAX_FILE_SIZE = 64 * 1024 * 1024;
const REQUEST_VISIBILITY_TIMEOUT_MS = 90_000;
const REQUEST_VISIBILITY_POLL_INTERVAL_MS = 2_000;
// `creating`/`uploading` are in-memory claims on the case row. A live upload
// bumps `updated_at` every heartbeat; a claim older than the stale window
// belongs to a process that died and may be taken over.
const CLAIM_HEARTBEAT_MS = 30_000;
const CLAIM_STALE_MS = 5 * 60_000;
/** Display name of the request type AIDA creates, as the form API expects. */
const OT_REQUEST_TYPE = "DSAR";
/** The form asks for these in AIDA-created requests; the user cannot pick them. */
const OT_COUNTRY = "United Kingdom";
const OT_ON_CF_GR = "No";
// OneTrust creates requests asynchronously. A request it accepted may take a
// while to show up, so for this long a saved trace ID counts as "created, not
// visible yet" and no second request is made.
const ACCEPTED_REQUEST_WINDOW_MS = 60 * 60_000;

/** OneTrust accepted the request but has not exposed it yet. Retry-safe. */
export class RequestPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestPendingError";
  }
}

type Settings = Awaited<ReturnType<typeof getAiBatchSettings>>;

function requiredSettings(settings: Settings) {
  if (
    !settings.oneTrustTenantUrl ||
    !settings.hasOneTrustClientId ||
    !settings.hasOneTrustClientSecret
  ) {
    throw new Error(
      "Configure the OneTrust tenant URL and OAuth credentials in System Settings.",
    );
  }
}

function nameParts(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error("The client case needs a subject name.");
  if (parts.length < 2) {
    throw new Error(
      "The client case needs both the subject's first name and surname.",
    );
  }
  // Two words are first name and surname; with more, the words in between are
  // the middle name(s).
  return {
    firstName: parts[0],
    middleNames: parts.slice(1, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function currentDate(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** fetch that waits and retries when OneTrust answers 429 (Retry-After). */
async function fetchOneTrust(
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) {
      return response;
    }
    await delay(retryDelayMs(response.headers.get("Retry-After"), attempt));
  }
}

async function accessToken(settings: Settings): Promise<string> {
  const credentials = await runtimeCredentials();
  if (!credentials.oneTrustClientId || !credentials.oneTrustClientSecret) {
    throw new Error("Configure OneTrust OAuth credentials in System Settings.");
  }
  const response = await fetchOneTrust(
    `${settings.oneTrustTenantUrl}/api/access/v1/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.oneTrustClientId,
        client_secret: credentials.oneTrustClientSecret,
      }),
      cache: "no-store",
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description || "OneTrust OAuth authentication failed.",
    );
  }
  return body.access_token;
}

async function oneTrustJson<T>(
  settings: Settings,
  token: string,
  endpoint: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchOneTrust(
    `${settings.oneTrustTenantUrl}${endpoint}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      cache: "no-store",
    },
  );
  const raw = await response.text();
  let body: {
    message?: string;
    error?: string;
  } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    // A non-JSON error body is surfaced below as raw text.
  }
  if (!response.ok) {
    throw new Error(
      body?.message ||
        body?.error ||
        raw ||
        `OneTrust request failed (${response.status} ${response.statusText}).`,
    );
  }
  return body as T;
}

interface OneTrustFormConfig {
  id: string;
  templateId: string;
  apiToken: string;
}

type OneTrustFormRow = Awaited<
  ReturnType<typeof prisma.oneTrustForm.findMany>
>[number];

/** The saved form for a case: the chosen one, or the only one there is. */
async function findForm(formId?: string | null) {
  const forms = await prisma.oneTrustForm.findMany({
    orderBy: { created_at: "asc" },
  });
  if (formId) return forms.find((candidate) => candidate.id === formId);
  return forms.length === 1 ? forms[0] : undefined;
}

/** Each web form carries its own mapping, label, language and user type. */
function withFormSettings(
  settings: Settings,
  form: OneTrustFormRow | undefined,
): Settings {
  if (!form) return settings;
  return {
    ...settings,
    oneTrustDateRaisedFieldKey: form.date_raised_field_key,
    oneTrustSystemLabel: form.system_label,
    oneTrustLanguage: form.language,
    oneTrustSubjectType: form.subject_type,
  };
}

/**
 * The privacy portal lives next to the tenant: `acme.my.onetrust.com` serves
 * its request API at `acme-privacy.my.onetrust.com`.
 */
function portalOrigin(settings: Settings): string {
  const tenant = new URL(settings.oneTrustTenantUrl);
  const [first, ...rest] = tenant.hostname.split(".");
  return `${tenant.protocol}//${[`${first}-privacy`, ...rest].join(".")}`;
}

async function loadForm(formId?: string | null): Promise<OneTrustFormConfig> {
  const form = await findForm(formId);
  if (!form) {
    const count = await prisma.oneTrustForm.count();
    throw new Error(
      count === 0
        ? "Add a OneTrust web form (name, ID and API token) in System Settings first."
        : formId
          ? "The selected OneTrust web form no longer exists."
          : "Choose which OneTrust web form to use.",
    );
  }
  return {
    id: form.id,
    templateId: form.template_id,
    apiToken: await decryptSetting(form.api_token_encrypted),
  };
}

async function createRequest(
  caseId: string,
  settings: Settings,
  token: string,
  formId?: string,
): Promise<OneTrustRequestIdentity> {
  const item = await prisma.managedCase.findUnique({ where: { id: caseId } });
  if (!item) throw new Error("Case not found.");
  const { firstName, middleNames, lastName } = nameParts(item.subject_name);
  if (!item.subject_email.trim())
    throw new Error("The client case needs a subject email.");
  const formConfig = await loadForm(formId);
  const requestTraceId = crypto.randomUUID();
  // Body shape from the web form's Integrate > API "Expected Payload": request
  // and user types go by display name, and no value may be null.
  const accepted = await createFormRequest(settings, formConfig, {
    firstName,
    lastName,
    email: item.subject_email,
    requestTypes: [OT_REQUEST_TYPE],
    subjectTypes: [settings.oneTrustSubjectType],
    language: settings.oneTrustLanguage,
    additionalData: {
      country: OT_COUNTRY,
      [settings.oneTrustDateRaisedFieldKey]: currentDate(),
      ...(middleNames ? { formField78: middleNames } : {}),
      ...(item.matter_numbers ? { loyaltyId: item.matter_numbers } : {}),
      requestDetails: "No additional request details provided.",
    },
    multiselectFields: { formField80: [OT_ON_CF_GR] },
    requestTraceId,
  });
  // Keep OneTrust's own trace ID (or ours) before anything else: it proves the
  // request was accepted, so a later click never creates a second one.
  const traceId = String(
    accepted.traceId || accepted.requestTraceId || requestTraceId,
  );
  // The public web form accepts the DSR before the authenticated API exposes
  // its reference ID and UUID. Persist that state, then poll before starting
  // delivery so the first click does not need a manual retry.
  await prisma.managedCase.update({
    where: { id: caseId },
    data: {
      onetrust_status: "awaiting_request",
      onetrust_error: null,
      onetrust_trace_id: traceId,
      onetrust_form_id: formConfig.id,
    },
  });
  const identity = await waitForPublicRequestIdentity(
    settings,
    token,
    firstName,
    lastName,
    item.subject_email,
    { caseId, traceId },
  );
  if (!identity)
    throw new RequestPendingError(
      "OneTrust accepted the request but did not expose it within 90 seconds. Try Send to OneTrust again shortly; AIDA will reuse the same request.",
    );
  await prisma.managedCase.update({
    where: { id: caseId },
    data: {
      onetrust_request_id: identity.requestId,
      onetrust_request_queue_id: identity.requestQueueId,
      onetrust_form_id: formConfig.id,
      onetrust_status: "created",
      onetrust_error: null,
    },
  });
  return identity;
}

interface OneTrustRequestIdentity {
  requestId: string;
  requestQueueId: string;
}

async function resolvePublicRequestIdentity(
  settings: Settings,
  token: string,
  firstName: string,
  lastName: string,
  email: string,
): Promise<OneTrustRequestIdentity | null> {
  const endpoint = new URL(
    `/api/datasubject/v2/requestqueues/${encodeURIComponent(settings.oneTrustLanguage)}`,
    settings.oneTrustTenantUrl,
  );
  endpoint.searchParams.set(
    "createddate",
    currentDate().slice(0, 10).replaceAll("-", ""),
  );
  endpoint.searchParams.set("size", "500");
  const response = await oneTrustJson<{
    content?: Array<{
      requestQueueRefId?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      dateCreated?: string;
      requestQueueId?: string;
    }>;
  }>(settings, token, `${endpoint.pathname}${endpoint.search}`, {
    method: "GET",
  });
  const entry = response.content
    ?.filter(
      (candidate) =>
        candidate.firstName === firstName &&
        candidate.lastName === lastName &&
        (candidate.email || "").toLowerCase() === email.toLowerCase(),
    )
    .sort((left, right) =>
      String(right.dateCreated || "").localeCompare(
        String(left.dateCreated || ""),
      ),
    )[0];
  if (!entry?.requestQueueRefId || !entry.requestQueueId) return null;
  return {
    requestId: entry.requestQueueRefId,
    requestQueueId: entry.requestQueueId,
  };
}

type CreationState =
  | { state: "pending" }
  | { state: "success" }
  | { state: "failed"; detail: string };

/**
 * Asks OneTrust how the asynchronous creation went
 * (GET /api/datasubject/v2/requestqueues/status/{requestTraceId}). Status
 * values are not documented, so only an explicit failure or an
 * `exceptionDescription` counts as failed; anything unclear stays pending.
 */
async function creationState(
  settings: Settings,
  token: string,
  traceId: string,
): Promise<CreationState> {
  if (!/^[0-9a-f-]{36}$/i.test(traceId)) return { state: "pending" };
  try {
    const response = await fetch(
      `${settings.oneTrustTenantUrl}/api/datasubject/v2/requestqueues/status/${encodeURIComponent(traceId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return { state: "pending" };
    const body = (await response.json().catch(() => ({}))) as {
      creationstatus?: string;
      creationStatus?: string;
      exceptionDescription?: string;
    };
    const status = String(body.creationstatus || body.creationStatus || "");
    const detail = String(body.exceptionDescription || "").trim();
    // OneTrust words "not finished yet" as an exceptionDescription too
    // ("Request creation is either under progress or it is not processed").
    if (/under progress|not processed|in progress|pending/i.test(detail))
      return { state: "pending" };
    if (/fail|error/i.test(status) || (detail && !/success/i.test(status))) {
      return {
        state: "failed",
        detail: detail || `OneTrust reported creation status ${status}.`,
      };
    }
    return /success/i.test(status)
      ? { state: "success" }
      : { state: "pending" };
  } catch {
    return { state: "pending" };
  }
}

/** A creation OneTrust rejected after accepting it: clear the trace so the next click may retry. */
async function failCreation(caseId: string, detail: string): Promise<never> {
  const message = `OneTrust could not create the request: ${detail}`;
  await prisma.managedCase.update({
    where: { id: caseId },
    data: {
      onetrust_status: "failed",
      onetrust_error: message,
      onetrust_trace_id: null,
    },
  });
  throw new Error(message);
}

async function waitForPublicRequestIdentity(
  settings: Settings,
  token: string,
  firstName: string,
  lastName: string,
  email: string,
  creation?: { caseId: string; traceId: string },
): Promise<OneTrustRequestIdentity | null> {
  const deadline = Date.now() + REQUEST_VISIBILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (creation) {
      const state = await creationState(settings, token, creation.traceId);
      if (state.state === "failed")
        return failCreation(creation.caseId, state.detail);
    }
    const identity = await resolvePublicRequestIdentity(
      settings,
      token,
      firstName,
      lastName,
      email,
    );
    if (identity) return identity;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await delay(Math.min(REQUEST_VISIBILITY_POLL_INTERVAL_MS, remaining));
  }
  return null;
}

/**
 * Creates the DSR through the web form's asynchronous request-creation API
 * (Integrate > API tab), authenticated with the form's JWT in the `accessToken`
 * header. Unlike the public form endpoint it does not require a captcha.
 */
async function createFormRequest(
  settings: Settings,
  formConfig: OneTrustFormConfig,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(
    `/request/v1/createv2request/${encodeURIComponent(formConfig.templateId)}`,
    portalOrigin(settings),
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      accessToken: formConfig.apiToken,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    // The raw response is used below when OneTrust does not provide JSON.
  }
  if (!response.ok) {
    throw new Error(
      String(
        parsed.message ||
          parsed.error ||
          raw ||
          `OneTrust request failed (${response.status} ${response.statusText}).`,
      ),
    );
  }
  return parsed;
}

async function collectFiles(root: string) {
  const output: Array<{
    localPath: string;
    relativePath: string;
    size: number;
    modifiedAt: number;
  }> = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (
        entry.isSymbolicLink() ||
        entry.name === ".DS_Store" ||
        entry.name.startsWith("._")
      )
        continue;
      const localPath = path.join(directory, entry.name);
      const relativePath = path.join(relative, entry.name);
      // Allowlist: only Emails/, Messages/ and Documents/ are ever sent, never
      // Discarded/, For Human Review/, Unconverted/ or hidden folders.
      if (entry.isDirectory()) {
        const top = relativePath.split(path.sep)[0];
        if (
          !["Emails", "Messages", "Documents"].includes(top) ||
          entry.name.startsWith(".") ||
          entry.name === "Unconverted"
        )
          continue;
        await visit(localPath, relativePath);
      } else if (entry.isFile() && isOneTrustDeliverablePath(relativePath)) {
        const stat = await fs.stat(localPath);
        output.push({
          localPath,
          relativePath,
          size: stat.size,
          modifiedAt: Math.floor(stat.mtimeMs),
        });
      }
    }
  };
  await visit(root, "");
  return output;
}

function attachmentNames(
  files: Array<{ relativePath: string }>,
  requestName: string,
) {
  const counts = new Map<string, number>();
  for (const file of files)
    counts.set(
      path.basename(file.relativePath),
      (counts.get(path.basename(file.relativePath)) || 0) + 1,
    );
  const used = new Map<string, number>();
  return files.map((file) => {
    const basename = path.basename(file.relativePath);
    const initial =
      (counts.get(basename) || 0) > 1
        ? `${requestName} — ${basename}`
        : basename;
    const count = (used.get(initial) || 0) + 1;
    used.set(initial, count);
    return count === 1 ? initial : `${initial} (${count})`;
  });
}

async function uploadDocument(
  settings: Settings,
  token: string,
  requestId: string,
  localPath: string,
  attachmentName: string,
) {
  const buffer = await fs.readFile(localPath);
  const form = new FormData();
  // OneTrust's generated API client submits the binary file and its metadata
  // separately: a `file` part plus an `attachment` JSON string.
  form.set("file", new Blob([buffer]), attachmentName);
  form.set(
    "attachment",
    JSON.stringify({
      FileName: attachmentName,
      Type: 30,
      RefIds: [requestId],
      IsInternal: true,
      Name: attachmentName,
      Comments: "AIDA client-case deliverable.",
    }),
  );
  const response = await fetchOneTrust(
    `${settings.oneTrustTenantUrl}/api/document/v2/attachments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      cache: "no-store",
    },
  );
  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Retain the textual response below when OneTrust returns a non-JSON error.
  }
  if (!response.ok) {
    const details = [
      body.message,
      body.error,
      body.detail,
      body.errors,
      body.validationErrors,
      raw,
    ]
      .filter(Boolean)
      .map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 1_000);
    throw new Error(
      details || `OneTrust file upload failed (${response.status}).`,
    );
  }
  const id = String(body.Id || body.id || body.fileId || "");
  if (!id) throw new Error("OneTrust did not return a file ID.");
  return id;
}

async function attachToResultSummary(
  settings: Settings,
  token: string,
  requestId: string,
  attachmentName: string,
  fileId: string,
  metadata?: EmailAttachmentMetadata,
) {
  await oneTrustJson(settings, token, resultSummaryPath(requestId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      resultSummaryBody(
        settings.oneTrustSystemLabel,
        attachmentName,
        fileId,
        metadata,
      ),
    ),
  });
}

/**
 * File ids OneTrust already shows on this request (read-back of every group), so
 * a retry never attaches the same file twice. A failed read returns an empty
 * set: the upload still proceeds, as before.
 */
async function alreadyAttachedFileIds(
  settings: Settings,
  token: string,
  requestRef: string,
): Promise<Set<string>> {
  try {
    const ref = encodeURIComponent(requestRef);
    const groups = await oneTrustJson<Array<{ groupId?: string }>>(
      settings,
      token,
      `/api/datasubject/v2/datadiscovery/requestqueues/${ref}`,
      { method: "GET" },
    );
    const details = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!group.groupId) continue;
      details.push(
        await oneTrustJson<{
          dataDiscoveryAttachmentListDtos?: Array<{ fileId?: string }>;
        }>(
          settings,
          token,
          `/api/datasubject/v2/datadiscovery/groups/${encodeURIComponent(group.groupId)}/requestqueues/${ref}?includeAttachments=true`,
          { method: "GET" },
        ),
      );
    }
    return attachedFileIds(details);
  } catch (error) {
    console.warn("[OneTrust] Could not read back attached files:", error);
    return new Set();
  }
}

/** Subject and sent date of each `Email N` PDF, from the render ledger. */
async function emailMetadataByNumber(
  deliverablePath: string,
): Promise<Map<number, EmailAttachmentMetadata>> {
  const result = new Map<number, EmailAttachmentMetadata>();
  try {
    const ledger = path.join(
      deliverablePath,
      ".work",
      "PST",
      ".unique-emails",
      "render-ledger.jsonl",
    );
    const hashes = ledgerHashesByNumber(await fs.readFile(ledger, "utf8"));
    const emails = await prisma.email.findMany({
      where: { email_hash: { in: [...hashes.values()] } },
      select: { email_hash: true, sent_date: true },
    });
    const items = await prisma.item.findMany({
      where: { id: { in: [...hashes.values()] } },
      select: { id: true, label: true },
    });
    const sent = new Map(emails.map((e) => [e.email_hash, e.sent_date]));
    const labels = new Map(items.map((i) => [i.id, i.label]));
    for (const [number, hash] of hashes) {
      const metadata = emailMetadata(labels.get(hash), sent.get(hash));
      if (metadata) result.set(number, metadata);
    }
  } catch {
    // No ledger (older request) or no database: send without metadata.
  }
  return result;
}

export async function sendCaseToOneTrust(caseId: string, formId?: string) {
  const item = await prisma.managedCase.findUnique({
    where: { id: caseId },
    include: { requests: true },
  });
  if (!item || item.status !== "active")
    throw new Error("Active case not found.");
  if (item.case_type !== "client")
    throw new Error("OneTrust delivery is available only for client cases.");
  if (item.requests.length !== 1 || item.requests[0].status !== "completed") {
    throw new Error(
      "Complete the client case's single request before sending it to OneTrust.",
    );
  }
  const effectiveFormId = item.onetrust_form_id || formId;
  const settings = withFormSettings(
    await getAiBatchSettings(),
    await findForm(effectiveFormId),
  );
  requiredSettings(settings);
  const token = await accessToken(settings);
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  const claimIsStale =
    (item.onetrust_status === "creating" ||
      item.onetrust_status === "uploading") &&
    item.updated_at < staleBefore;
  const currentStatus = claimIsStale ? "idle" : item.onetrust_status;
  const acceptedRecently =
    Boolean(item.onetrust_trace_id) &&
    item.updated_at.getTime() > Date.now() - ACCEPTED_REQUEST_WINDOW_MS;
  const awaitingRequest =
    currentStatus === "creating" ||
    currentStatus === "awaiting_request" ||
    acceptedRecently;
  let requestId = item.onetrust_request_id;
  let requestQueueId = item.onetrust_request_queue_id;
  let resolvedExistingRequest = false;
  if (!requestId || !requestQueueId) {
    const identity = awaitingRequest
      ? await waitForPublicRequestIdentity(
          settings,
          token,
          nameParts(item.subject_name).firstName,
          nameParts(item.subject_name).lastName,
          item.subject_email,
          item.onetrust_trace_id
            ? { caseId, traceId: item.onetrust_trace_id }
            : undefined,
        )
      : await resolvePublicRequestIdentity(
          settings,
          token,
          nameParts(item.subject_name).firstName,
          nameParts(item.subject_name).lastName,
          item.subject_email,
        );
    requestId = identity?.requestId || requestId;
    requestQueueId = identity?.requestQueueId || requestQueueId;
    resolvedExistingRequest = Boolean(identity);
  }
  if (requestId && resolvedExistingRequest) {
    await prisma.managedCase.update({
      where: { id: caseId },
      data: {
        onetrust_request_id: requestId,
        onetrust_request_queue_id: requestQueueId,
        onetrust_status: "created",
        onetrust_error: null,
      },
    });
  }
  if (!requestId) {
    if (awaitingRequest) {
      await prisma.managedCase.update({
        where: { id: caseId },
        data: { onetrust_status: "awaiting_request", onetrust_error: null },
      });
      throw new RequestPendingError(
        "OneTrust has accepted this request but has not exposed it for delivery yet. Try Send to OneTrust again shortly; AIDA will reuse the same request.",
      );
    }
    const claim = await prisma.managedCase.updateMany({
      where: {
        id: caseId,
        onetrust_request_id: null,
        OR: [
          { onetrust_status: { not: "creating" } },
          { updated_at: { lt: staleBefore } },
        ],
      },
      data: { onetrust_status: "creating", onetrust_error: null },
    });
    if (claim.count === 0) {
      throw new Error(
        "A OneTrust request is already being created for this case.",
      );
    }
    let identity: OneTrustRequestIdentity;
    try {
      identity = await createRequest(caseId, settings, token, effectiveFormId);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "OneTrust request creation failed.";
      if (!(error instanceof RequestPendingError)) {
        await prisma.managedCase.update({
          where: { id: caseId },
          data: { onetrust_status: "failed", onetrust_error: message },
        });
      }
      throw error;
    }
    requestId = identity.requestId;
    requestQueueId = identity.requestQueueId;
  }
  if (!requestId || !requestQueueId)
    throw new Error(
      "OneTrust did not expose the request UUID required to upload attachments.",
    );
  const uploadClaim = await prisma.managedCase.updateMany({
    where: {
      id: caseId,
      OR: [
        { onetrust_status: { notIn: ["creating", "uploading"] } },
        { updated_at: { lt: staleBefore } },
      ],
    },
    data: { onetrust_status: "uploading", onetrust_error: null },
  });
  if (uploadClaim.count === 0) {
    throw new Error("OneTrust delivery is already in progress for this case.");
  }
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const heartbeat = setInterval(() => {
    // Conditional so a late tick can never overwrite the final status.
    prisma.managedCase
      .updateMany({
        where: { id: caseId, onetrust_status: "uploading" },
        data: { onetrust_status: "uploading" },
      })
      .catch(() => undefined);
  }, CLAIM_HEARTBEAT_MS);
  try {
    // Names must be a gapless sequence after manual additions or deletions.
    // Renaming files OneTrust already holds would upload them a second time
    // under their new names, so it only happens before the first upload.
    const alreadySent = await prisma.oneTrustUploadArtifact.count({
      where: {
        case_id: caseId,
        OR: [{ status: "completed" }, { remote_file_id: { not: null } }],
      },
    });
    const renamed =
      alreadySent === 0
        ? renumberDeliverables(item.requests[0].deliverable_path).renamed
        : 0;
    // Email numbers match the render ledger only when nothing was renamed by
    // hand; a wrong subject next to a file is worse than none.
    const metadataByNumber =
      renamed === 0
        ? await emailMetadataByNumber(item.requests[0].deliverable_path)
        : new Map<number, EmailAttachmentMetadata>();
    // Read back with the request reference, the id the attach call uses.
    const attached = await alreadyAttachedFileIds(settings, token, requestId);
    const files = await collectFiles(item.requests[0].deliverable_path);
    const names = attachmentNames(files, item.requests[0].name);
    for (const [index, file] of files.entries()) {
      const attachmentName = names[index];
      const existing = await prisma.oneTrustUploadArtifact.findUnique({
        where: { local_path: file.localPath },
      });
      if (
        existing?.status === "completed" &&
        existing.file_size_bytes === BigInt(file.size) &&
        existing.modified_at === BigInt(file.modifiedAt)
      )
        continue;
      if (file.size > MAX_FILE_SIZE) {
        skipped++;
        await prisma.oneTrustUploadArtifact.upsert({
          where: { local_path: file.localPath },
          create: {
            id: crypto.randomUUID(),
            case_id: caseId,
            local_path: file.localPath,
            relative_path: file.relativePath,
            attachment_name: attachmentName,
            file_size_bytes: BigInt(file.size),
            modified_at: BigInt(file.modifiedAt),
            status: "skipped",
            attempts: 0,
            error_message: "Exceeds OneTrust's 64 MB attachment limit.",
          },
          update: {
            attachment_name: attachmentName,
            file_size_bytes: BigInt(file.size),
            modified_at: BigInt(file.modifiedAt),
            status: "skipped",
            error_message: "Exceeds OneTrust's 64 MB attachment limit.",
          },
        });
        continue;
      }
      try {
        let fileId =
          existing?.remote_file_id &&
          existing.file_size_bytes === BigInt(file.size) &&
          existing.modified_at === BigInt(file.modifiedAt)
            ? existing.remote_file_id
            : "";
        if (!fileId) {
          fileId = await uploadDocument(
            settings,
            token,
            requestQueueId,
            file.localPath,
            attachmentName,
          );
          await prisma.oneTrustUploadArtifact.upsert({
            where: { local_path: file.localPath },
            create: {
              id: crypto.randomUUID(),
              case_id: caseId,
              local_path: file.localPath,
              relative_path: file.relativePath,
              attachment_name: attachmentName,
              file_size_bytes: BigInt(file.size),
              modified_at: BigInt(file.modifiedAt),
              remote_file_id: fileId,
              status: "uploaded",
              attempts: 1,
            },
            update: {
              attachment_name: attachmentName,
              file_size_bytes: BigInt(file.size),
              modified_at: BigInt(file.modifiedAt),
              remote_file_id: fileId,
              status: "uploaded",
              attempts: { increment: 1 },
              error_message: null,
            },
          });
        }
        if (!attached.has(fileId)) {
          const number = emailNumberFromPath(file.relativePath);
          await attachToResultSummary(
            settings,
            token,
            requestId,
            attachmentName,
            fileId,
            number === null ? undefined : metadataByNumber.get(number),
          );
        }
        uploaded++;
        await prisma.oneTrustUploadArtifact.upsert({
          where: { local_path: file.localPath },
          create: {
            id: crypto.randomUUID(),
            case_id: caseId,
            local_path: file.localPath,
            relative_path: file.relativePath,
            attachment_name: attachmentName,
            file_size_bytes: BigInt(file.size),
            modified_at: BigInt(file.modifiedAt),
            remote_file_id: fileId,
            status: "completed",
            attempts: 1,
          },
          update: {
            attachment_name: attachmentName,
            file_size_bytes: BigInt(file.size),
            modified_at: BigInt(file.modifiedAt),
            remote_file_id: fileId,
            status: "completed",
            attempts: { increment: 1 },
            error_message: null,
          },
        });
      } catch (error) {
        failed++;
        await prisma.oneTrustUploadArtifact.upsert({
          where: { local_path: file.localPath },
          create: {
            id: crypto.randomUUID(),
            case_id: caseId,
            local_path: file.localPath,
            relative_path: file.relativePath,
            attachment_name: attachmentName,
            file_size_bytes: BigInt(file.size),
            modified_at: BigInt(file.modifiedAt),
            status: "failed",
            attempts: 1,
            error_message:
              error instanceof Error ? error.message : "Upload failed.",
          },
          update: {
            attachment_name: attachmentName,
            file_size_bytes: BigInt(file.size),
            modified_at: BigInt(file.modifiedAt),
            status: "failed",
            attempts: { increment: 1 },
            error_message:
              error instanceof Error ? error.message : "Upload failed.",
          },
        });
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
  const status = failed || skipped ? "partial" : "completed";
  const message = failed
    ? `${failed} file${failed === 1 ? "" : "s"} failed to upload.`
    : skipped
      ? `${skipped} file${skipped === 1 ? "" : "s"} exceeded OneTrust's 64 MB limit.`
      : null;
  await prisma.managedCase.update({
    where: { id: caseId },
    data: { onetrust_status: status, onetrust_error: message },
  });
  return { requestId, uploaded, skipped, failed, status };
}
