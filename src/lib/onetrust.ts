import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runtimeCredentials } from "./credentials";
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

type Settings = Awaited<ReturnType<typeof getAiBatchSettings>>;

function requiredSettings(settings: Settings) {
  if (
    !settings.oneTrustTenantUrl ||
    !settings.oneTrustTemplateId ||
    !settings.oneTrustPublicWebFormUrl ||
    !settings.oneTrustDateRaisedFieldKey ||
    !settings.hasOneTrustClientId ||
    !settings.hasOneTrustClientSecret
  ) {
    throw new Error(
      "Configure OneTrust tenant, OAuth credentials, template, and Date Raised field key in System Settings.",
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
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function currentDate(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function accessToken(settings: Settings): Promise<string> {
  const credentials = await runtimeCredentials();
  if (!credentials.oneTrustClientId || !credentials.oneTrustClientSecret) {
    throw new Error("Configure OneTrust OAuth credentials in System Settings.");
  }
  const response = await fetch(
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
  const response = await fetch(`${settings.oneTrustTenantUrl}${endpoint}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    cache: "no-store",
  });
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

async function createRequest(
  caseId: string,
  settings: Settings,
  token: string,
): Promise<OneTrustRequestIdentity> {
  const item = await prisma.managedCase.findUnique({ where: { id: caseId } });
  if (!item) throw new Error("Case not found.");
  const { firstName, lastName } = nameParts(item.subject_name);
  if (!item.subject_email.trim())
    throw new Error("The client case needs a subject email.");
  const form = await publishedWebForm(settings);
  await publicRequest(settings, {
    firstName,
    lastName,
    email: item.subject_email,
    requestTypes: ["RequestType3"],
    subjectTypes: [settings.oneTrustSubjectType],
    additionalData: {
      formField78: "",
      loyaltyId: "",
      infoRequestHelpText: "",
      howWeUseHelpText: "",
      vendorId: "",
      employeeId: "",
      moreDetailsHelpText: "",
      [settings.oneTrustDateRaisedFieldKey]: currentDate(),
      requestDetails: "No additional request details provided.",
    },
    multiselectFields: {},
    daysToRespond: "",
    language: settings.oneTrustLanguage,
    botDetectCaptcha: false,
    googleRecaptcha: false,
    captchaId: "",
    captchaCode: "",
    dataLocalizationEnabled: false,
    published: true,
    attachments: null,
    identityTokens: {},
    requestTraceId: crypto.randomUUID(),
    webformConfig: form,
    jwtToken: String(form.jwtToken || ""),
  });
  // The public web form accepts the DSR before the authenticated API exposes
  // its reference ID and UUID. Persist that state, then poll before starting
  // delivery so the first click does not need a manual retry.
  await prisma.managedCase.update({
    where: { id: caseId },
    data: { onetrust_status: "awaiting_request", onetrust_error: null },
  });
  const identity = await waitForPublicRequestIdentity(
    settings,
    token,
    firstName,
    lastName,
    item.subject_email,
  );
  if (!identity)
    throw new Error(
      "OneTrust accepted the request but did not expose it within 90 seconds. Try Send to OneTrust again shortly; AIDA will reuse the same request.",
    );
  await prisma.managedCase.update({
    where: { id: caseId },
    data: {
      onetrust_request_id: identity.requestId,
      onetrust_request_queue_id: identity.requestQueueId,
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

async function waitForPublicRequestIdentity(
  settings: Settings,
  token: string,
  firstName: string,
  lastName: string,
  email: string,
): Promise<OneTrustRequestIdentity | null> {
  const deadline = Date.now() + REQUEST_VISIBILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
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

async function publishedWebForm(
  settings: Settings,
): Promise<Record<string, unknown>> {
  const response = await fetch(settings.oneTrustPublicWebFormUrl, {
    headers: { Accept: "text/html" },
    cache: "no-store",
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(
      `Unable to load the published OneTrust web form (${response.status}).`,
    );
  }
  const state = html.match(
    /<script id="dsar-components-state" type="application\/json">([\s\S]*?)<\/script>/,
  )?.[1];
  if (!state) {
    throw new Error(
      "The published OneTrust web form did not provide its request configuration.",
    );
  }
  let parsed: Record<string, { body?: Record<string, unknown> }>;
  try {
    parsed = JSON.parse(
      state
        .replaceAll("&q;", '"')
        .replaceAll("&a;", "&")
        .replaceAll("&l;", "<")
        .replaceAll("&g;", ">"),
    );
  } catch {
    throw new Error(
      "The published OneTrust web form returned an invalid request configuration.",
    );
  }
  const entry = Object.entries(parsed).find(([key]) =>
    key.includes(`/webform/${settings.oneTrustTemplateId}/publish?`),
  )?.[1];
  if (!entry?.body?.jwtToken) {
    throw new Error(
      "The published OneTrust web form did not provide a usable request token.",
    );
  }
  return entry.body;
}

async function publicRequest(
  settings: Settings,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(
    "/request/v1/dsarrequestqueue",
    settings.oneTrustPublicWebFormUrl,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: endpoint.origin,
      Referer: settings.oneTrustPublicWebFormUrl,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    // The raw response is returned below when OneTrust does not provide JSON.
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
      if (entry.isDirectory()) await visit(localPath, relativePath);
      else if (entry.isFile()) {
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
  const response = await fetch(
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
) {
  await oneTrustJson(
    settings,
    token,
    `/api/datasubject/v2/datadiscovery/requestqueues/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: settings.oneTrustSystemLabel,
        // OneTrust's Results Summary API requires the dataset container even
        // when this integration contributes only document attachments.
        results: {},
        attachments: [{ fileName: attachmentName, fileId }],
      }),
    },
  );
}

export async function sendCaseToOneTrust(caseId: string) {
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
  const settings = await getAiBatchSettings();
  requiredSettings(settings);
  const token = await accessToken(settings);
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  const claimIsStale =
    (item.onetrust_status === "creating" ||
      item.onetrust_status === "uploading") &&
    item.updated_at < staleBefore;
  const currentStatus = claimIsStale ? "idle" : item.onetrust_status;
  let requestId = item.onetrust_request_id;
  let requestQueueId = item.onetrust_request_queue_id;
  let resolvedExistingRequest = false;
  if (!requestId || !requestQueueId) {
    const identity =
      currentStatus === "creating" || currentStatus === "awaiting_request"
        ? await waitForPublicRequestIdentity(
            settings,
            token,
            nameParts(item.subject_name).firstName,
            nameParts(item.subject_name).lastName,
            item.subject_email,
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
    if (currentStatus === "creating" || currentStatus === "awaiting_request") {
      await prisma.managedCase.update({
        where: { id: caseId },
        data: { onetrust_status: "awaiting_request", onetrust_error: null },
      });
      throw new Error(
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
      identity = await createRequest(caseId, settings, token);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "OneTrust request creation failed.";
      if (!message.startsWith("OneTrust accepted the request")) {
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
        await attachToResultSummary(
          settings,
          token,
          requestId,
          attachmentName,
          fileId,
        );
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
