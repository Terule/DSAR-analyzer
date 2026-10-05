import { promises as fs } from "node:fs";
import path from "node:path";
import { runtimeCredentials } from "./credentials";
import { getAiBatchSettings } from "./pipeline-settings";

export interface SharePointFolder {
  id: string;
  name: string;
  path: string;
}

interface GraphDriveItem {
  id: string;
  name: string;
  folder?: Record<string, unknown>;
  parentReference?: { path?: string };
}

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

const MAX_GRAPH_RETRIES = 6;
const MIN_REQUEST_INTERVAL_MS = 250;
let nextGraphRequestAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(60_000, 1_000 * 2 ** attempt);
}

async function throttledFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const waitMs = Math.max(0, nextGraphRequestAt - Date.now());
    if (waitMs > 0) await delay(waitMs);
    nextGraphRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;

    const response = await fetch(input, init);
    if (
      ![429, 503, 504].includes(response.status) ||
      attempt >= MAX_GRAPH_RETRIES
    ) {
      return response;
    }
    const retryMs = retryDelayMs(response, attempt);
    nextGraphRequestAt = Math.max(nextGraphRequestAt, Date.now() + retryMs);
    await delay(retryMs);
  }
}

async function graphAccessToken(): Promise<string> {
  const credentials = await runtimeCredentials();
  if (
    !credentials.azureTenantId ||
    !credentials.azureClientId ||
    !credentials.azureClientSecret
  ) {
    throw new Error("Configure Azure application credentials in Settings.");
  }
  const tenantId = credentials.azureTenantId;
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.azureClientId,
        client_secret: credentials.azureClientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description || "Could not authenticate with SharePoint.",
    );
  }
  return body.access_token;
}

async function graphJson<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await throttledFetch(
    `https://graph.microsoft.com/v1.0${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init?.headers,
      },
      cache: "no-store",
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      `SharePoint request ${response.status} for ${path} failed: ${
        body.error?.message || "request was not accepted"
      }`,
    );
  }
  return body as T;
}

interface SharePointDrive {
  id: string;
}

async function getSharePointDrive(token: string): Promise<SharePointDrive> {
  const { sharePointSiteUrl } = await getAiBatchSettings();
  if (!sharePointSiteUrl) {
    throw new Error(
      "Save a SharePoint site URL in Pipeline settings before uploading.",
    );
  }

  const siteUrl = new URL(sharePointSiteUrl);
  const sitePath = siteUrl.pathname.replace(/\/+$/, "");
  if (!sitePath)
    throw new Error("The SharePoint site URL must include its site path.");

  const site = await graphJson<{ id: string }>(
    `/sites/${encodeURIComponent(siteUrl.hostname)}:${sitePath}`,
    token,
  );
  return graphJson<SharePointDrive>(`/sites/${site.id}/drive`, token);
}

function folderPath(item: GraphDriveItem): string {
  const parentPath = item.parentReference?.path || "";
  const rootIndex = parentPath.indexOf("/root:");
  const parent = rootIndex >= 0 ? parentPath.slice(rootIndex + 6) : "";
  return `${parent}/${item.name}`.replace(/\/+/g, "/");
}

export async function listSharePointFolderChildren(
  parentId?: string,
): Promise<SharePointFolder[]> {
  const { sharePointSiteUrl } = await getAiBatchSettings();
  if (!sharePointSiteUrl) {
    throw new Error(
      "Save a SharePoint site URL in Pipeline settings before searching.",
    );
  }

  const token = await graphAccessToken();
  const drive = await getSharePointDrive(token);
  const parent = parentId ? `/items/${encodeURIComponent(parentId)}` : "/root";
  const endpoint = `/drives/${drive.id}${parent}/children?$select=id,name,folder,parentReference&$top=200`;
  const items = await graphJson<GraphCollection<GraphDriveItem>>(
    endpoint,
    token,
  );

  return (items.value || [])
    .filter((item) => item.folder)
    .map((item) => ({ id: item.id, name: item.name, path: folderPath(item) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function ensureFolder(
  driveId: string,
  parentId: string,
  name: string,
  token: string,
  cache: Map<string, string>,
): Promise<string> {
  const cacheKey = `${parentId}:${name}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  // Graph pages large folders (`Emails/` holds thousands of children). Follow
  // @odata.nextLink so an existing folder past the first page is found instead
  // of being re-created, which fails with 409 "Name already exists".
  let existing: GraphDriveItem | undefined;
  let nextPath: string | undefined =
    `/drives/${driveId}/items/${parentId}/children?$select=id,name,folder&$top=200`;
  while (nextPath && !existing) {
    const page: GraphCollection<GraphDriveItem> = await graphJson(
      nextPath,
      token,
    );
    existing = page.value?.find((item) => item.name === name && item.folder);
    const nextLink = page["@odata.nextLink"];
    nextPath = nextLink
      ? nextLink.replace("https://graph.microsoft.com/v1.0", "")
      : undefined;
  }
  if (existing) {
    cache.set(cacheKey, existing.id);
    return existing.id;
  }

  const created = await graphJson<GraphDriveItem>(
    `/drives/${driveId}/items/${parentId}/children`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  cache.set(cacheKey, created.id);
  return created.id;
}

async function* filesInDirectory(
  directory: string,
): AsyncGenerator<{ relativePath: string; fullPath: string; size: number }> {
  const visit = async function* (
    current: string,
    relativePath: string,
  ): AsyncGenerator<{ relativePath: string; fullPath: string; size: number }> {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      const nextRelativePath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        yield* visit(fullPath, nextRelativePath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        yield { relativePath: nextRelativePath, fullPath, size: stat.size };
      }
    }
  };

  yield* visit(directory, "");
}

async function uploadFile(
  driveId: string,
  folderId: string,
  filePath: string,
  fileSize: number,
  token: string,
): Promise<void> {
  const filename = encodeURIComponent(path.basename(filePath));
  if (fileSize === 0) {
    await graphJson(
      `/drives/${driveId}/items/${folderId}:/${filename}:/content`,
      token,
      { method: "PUT", body: new Uint8Array() },
    );
    return;
  }

  const session = await graphJson<{ uploadUrl?: string }>(
    `/drives/${driveId}/items/${folderId}:/${filename}:/createUploadSession`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: { "@microsoft.graph.conflictBehavior": "replace" },
      }),
    },
  );
  if (!session.uploadUrl)
    throw new Error(`Could not create an upload session for ${filePath}.`);

  const handle = await fs.open(filePath, "r");
  try {
    const chunkSize = 10 * 1024 * 1024;
    let position = 0;
    while (position < fileSize) {
      const length = Math.min(chunkSize, fileSize - position);
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, position);
      const response = await throttledFetch(session.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(length),
          "Content-Range": `bytes ${position}-${position + length - 1}/${fileSize}`,
        },
        body: buffer,
      });
      if (!response.ok) {
        throw new Error(
          `Uploading ${filePath} failed with status ${response.status}.`,
        );
      }
      position += length;
    }
  } finally {
    await handle.close();
  }
}

export async function uploadCaseDeliverables(
  requestKeys: Iterable<string>,
  onProgress?: (uploaded: number, total: number) => Promise<void>,
  resumeFrom = 0,
): Promise<{ filesUploaded: number; filesTotal: number }> {
  const settings = await getAiBatchSettings();
  if (!settings.sharePointFolderId) {
    throw new Error(
      "Select and save a SharePoint destination folder before uploading.",
    );
  }
  const outputRoot = process.env.EXTRACTED_PATH;
  if (!outputRoot) throw new Error("EXTRACTED_PATH is not configured.");

  const token = await graphAccessToken();
  const drive = await getSharePointDrive(token);
  const folderCache = new Map<string, string>();
  const keys = [...requestKeys];
  const filesTotal = await countCaseDeliverableFiles(keys);
  let filesUploaded = Math.min(resumeFrom, filesTotal);
  let filesSeen = 0;
  for (const requestKey of keys) {
    const [caseName, requestName] = requestKey.split("/");
    if (!caseName || !requestName) {
      throw new Error(`Invalid case key for SharePoint upload: ${requestKey}`);
    }
    const dsrFolder = await ensureFolder(
      drive.id,
      settings.sharePointFolderId,
      `DSR-${caseName}`,
      token,
      folderCache,
    );
    const requestFolder = await ensureFolder(
      drive.id,
      dsrFolder,
      requestName,
      token,
      folderCache,
    );
    for (const category of ["Emails", "Messages", "Documents"]) {
      const localDirectory = path.join(outputRoot, requestKey, category);
      try {
        const stat = await fs.stat(localDirectory);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      const categoryFolder = await ensureFolder(
        drive.id,
        requestFolder,
        category,
        token,
        folderCache,
      );
      for await (const file of filesInDirectory(localDirectory)) {
        filesSeen++;
        if (filesSeen <= filesUploaded) continue;
        let parentFolder = categoryFolder;
        const relativeParts = file.relativePath.split(path.sep);
        for (const directory of relativeParts.slice(0, -1)) {
          parentFolder = await ensureFolder(
            drive.id,
            parentFolder,
            directory,
            token,
            folderCache,
          );
        }
        await uploadFile(
          drive.id,
          parentFolder,
          file.fullPath,
          file.size,
          token,
        );
        filesUploaded++;
        if (filesUploaded % 5 === 0 || filesUploaded === filesTotal) {
          await onProgress?.(filesUploaded, filesTotal);
        }
      }
    }
  }
  return { filesUploaded, filesTotal };
}

export async function countCaseDeliverableFiles(
  requestKeys: Iterable<string>,
): Promise<number> {
  const outputRoot = process.env.EXTRACTED_PATH;
  if (!outputRoot) throw new Error("EXTRACTED_PATH is not configured.");

  let total = 0;
  for (const requestKey of requestKeys) {
    for (const category of ["Emails", "Messages", "Documents"]) {
      const localDirectory = path.join(outputRoot, requestKey, category);
      try {
        const stat = await fs.stat(localDirectory);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      for await (const _file of filesInDirectory(localDirectory)) total++;
    }
  }
  return total;
}

/** Upload one verified deliverable from the durable artifact outbox. */
export async function uploadSharePointArtifact(input: {
  requestKey: string;
  localPath: string;
  relativePath: string;
}): Promise<void> {
  const settings = await getAiBatchSettings();
  if (!settings.sharePointFolderId) {
    throw new Error(
      "Select and save a SharePoint destination folder before uploading.",
    );
  }
  const [caseName, requestName] = input.requestKey.split("/");
  if (!caseName || !requestName) {
    throw new Error(
      `Invalid case key for SharePoint upload: ${input.requestKey}`,
    );
  }
  const relativeParts = input.relativePath.split(/[\\/]/).filter(Boolean);
  const filename = relativeParts.pop();
  if (!filename)
    throw new Error(`Invalid SharePoint artifact path: ${input.relativePath}`);

  const stat = await fs.stat(input.localPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(
      `SharePoint artifact is not a finalized file: ${input.localPath}`,
    );
  }

  const token = await graphAccessToken();
  const drive = await getSharePointDrive(token);
  const cache = new Map<string, string>();
  let destination = await ensureFolder(
    drive.id,
    settings.sharePointFolderId,
    `DSR-${caseName}`,
    token,
    cache,
  );
  destination = await ensureFolder(
    drive.id,
    destination,
    requestName,
    token,
    cache,
  );
  for (const part of relativeParts) {
    destination = await ensureFolder(drive.id, destination, part, token, cache);
  }
  await uploadFile(drive.id, destination, input.localPath, stat.size, token);
}
