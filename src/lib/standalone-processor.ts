import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";
import { simpleParser } from "mailparser";
import {
  normalizeHtmlForPdf,
  processImageToPdf,
  processTextToPdf,
} from "./converter";
import { stripEmailSignature } from "./email-content";
import { discardedForKeyword } from "./email-rules";
import {
  hasPrivilegedKeyword,
  hasPrivilegedKeywordInDocument,
  hasPrivilegedKeywordInFileName,
} from "./exclusions";
import { convertImageToPng } from "./image-convert";
import {
  classifyImage,
  IMAGE_EXTENSIONS,
  readImageFacts,
  UNRENDERABLE_IMAGE_EXTENSIONS,
} from "./image-rules";
import type { ImageContentJudge } from "./image-vision";
import { judgeImageWithVision, visionEnabled } from "./image-vision";
import type { ChildItemDecision } from "./items";
import { fileDiscardRule } from "./items";
import { mediaKind } from "./media-types";
import {
  isPasswordProtectedFile,
  isPasswordProtectionError,
} from "./password-protection";
import {
  type FilesPrefix,
  formatNumber,
  highestNumber,
  isUnfinalizedName,
  numberWidth,
} from "./request-waves";
import {
  buildSubjectIdentifiers,
  buildSubjectTokens,
  isSentToPersonalAddress,
  mentionsSubject,
  textShowsSentToPersonalAddress,
} from "./subject-rules";
import {
  buildExcerpts,
  CHAT_CONTEXT_MESSAGES,
  excerptText,
  messageCitesSubject,
  messageKey,
  parseChatMessages,
  renderExcerptsHtml,
} from "./teams-chat";
import {
  prescreenThresholdMb,
  scanXlsxForMentions,
  shouldPrescreenSpreadsheet,
} from "./xlsx-mention-scan";

export interface StandaloneBatchParams {
  inputDir: string;
  /** A dispatcher-provided slice of the input tree for parallel batch jobs. */
  filePaths?: string[];
  messagesDir: string;
  documentsDir: string;
  subjectCriteria: {
    name: string;
    email?: string;
    personalEmail?: string;
    aliases?: string[];
  };
  /** Client cases retain all unique content, without relevance exclusions. */
  clientMode?: boolean;
  /** Audit trail: called for every file the filters discard, with the rule and reason. */
  onDecision?: (decision: FileDecision) => void;
  /**
   * Reads what an image shows (same policy as a document). Only a discard is
   * acted on here: a kept or doubtful image still becomes a PDF, and the Files
   * AI gate (which cannot read a picture) sends it to a person.
   */
  judgeImage?: ImageContentJudge;
}

export interface FileDecision {
  filePath: string;
  state: "discarded" | "kept";
  rule: string;
  reason: string;
  /**
   * An image the AI read and kept: the Files AI gate cannot read a picture, so
   * this verdict is recorded for it and the image is delivered as judged.
   */
  aiVerdict?: { verdict: "keep"; reason: string };
  /** Who decided, when it was not a fixed rule (`ai` for an image the AI read). */
  decidedBy?: string;
  /** For a kept file: where it was delivered, as `Documents/<name>` or `Messages/<name>`. */
  deliveredRel?: string;
  /** For a chat export: what happened to each message that cites the subject. */
  messages?: ChildItemDecision[];
}

export interface StandaloneBatchResult {
  success: boolean;
  error?: string;
  message?: string;
  processedCount?: number;
  skippedCount?: number;
  duplicatesCount?: number;
}

export interface FilesDeliverableRenameResult {
  documents: number;
  messages: number;
}

export interface UnconvertedFilesResult {
  copied: number;
  missing: number;
  /** Large workbooks confirmed not to mention the subject: not delivered. */
  dropped: number;
}

const MESSAGE_EXTENSIONS = new Set([".html", ".htm", ".eml", ".msg"]);

/**
 * Preserve files whose conversion worker could not complete after retries.
 * They intentionally live below Unconverted so clean PDF deliverables retain
 * their stable Document/Message numbering during finalization.
 */
export async function copyUnconvertedStandaloneFiles(input: {
  filePaths: string[];
  messagesDir: string;
  documentsDir: string;
  /**
   * The subject's search terms. When given, a large workbook that cannot mention
   * the subject is not delivered, exactly as the normal conversion would have
   * dropped it (every case type).
   */
  criteria?: string[];
}): Promise<UnconvertedFilesResult> {
  let copied = 0;
  let missing = 0;
  let dropped = 0;

  for (const filePath of input.filePaths) {
    if (!fs.existsSync(filePath)) {
      missing++;
      continue;
    }
    if (isPasswordProtectedFile(filePath)) {
      console.log(
        `[Standalone Filter] Not delivering unconverted ${path.basename(filePath)}: password-protected/encrypted file.`,
      );
      dropped++;
      continue;
    }
    const extension = path.extname(filePath).toLowerCase();
    if (
      input.criteria &&
      input.criteria.length > 0 &&
      shouldPrescreenSpreadsheet(
        extension,
        fs.statSync(filePath).size,
        prescreenThresholdMb(),
      ) &&
      (await scanXlsxForMentions(filePath, input.criteria)).status ===
        "not-mentioned"
    ) {
      console.log(
        `[Standalone Filter] Not delivering unconverted ${path.basename(filePath)}: the subject is not mentioned anywhere in this large workbook (streamed scan).`,
      );
      dropped++;
      continue;
    }
    const category = MESSAGE_EXTENSIONS.has(extension)
      ? input.messagesDir
      : input.documentsDir;
    const destinationDir = path.join(category, "Unconverted");
    await fs.promises.mkdir(destinationDir, { recursive: true });
    // Include the source-path hash so two exported files with the same basename
    // are both retained without overwriting each other.
    const destinationName = `${crypto
      .createHash("sha256")
      .update(path.resolve(filePath))
      .digest("hex")
      .slice(0, 12)}-${path.basename(filePath)}`;
    await fs.promises.copyFile(
      filePath,
      path.join(destinationDir, destinationName),
    );
    copied++;
  }

  return { copied, missing, dropped };
}

// Recursive file scanner to handle messy nested export folders
function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    if (fs.statSync(`${dirPath}/${file}`).isDirectory()) {
      arrayOfFiles = getAllFiles(`${dirPath}/${file}`, arrayOfFiles);
    } else {
      arrayOfFiles.push(path.join(dirPath, file));
    }
  });

  return arrayOfFiles;
}

export function listStandaloneInputFiles(inputDir: string): string[] {
  if (!fs.existsSync(inputDir)) return [];
  return getAllFiles(inputDir)
    .filter((filePath) => {
      const filename = path.basename(filePath).toLowerCase();
      return !filename.startsWith(".") && !filename.endsWith(".json");
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Converts the collision-safe hash filenames produced by parallel workers into
 * a clean deliverable sequence once no worker can still write to the folders.
 * Only hash-named files are renamed: files finalized by an earlier wave of the
 * request keep their names and the new ones continue after the highest
 * existing number. Two-stage renaming makes the operation safe even when a
 * target name already exists from a previous attempt.
 */
function renameDeliverableFolder(folder: string, prefix: FilesPrefix): number {
  if (!fs.existsSync(folder)) return 0;
  const names = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const files = names
    .filter((name) => isUnfinalizedName(name, prefix))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const finalized = names.filter((name) => !isUnfinalizedName(name, prefix));
  const start = highestNumber(finalized, prefix);
  // Keep names compact while preserving natural lexical ordering: 1–9 needs
  // no padding, 10–99 needs two digits, and so on. Never narrower than names
  // already delivered, which are not renamed when the width grows.
  const padLength = numberWidth(finalized, prefix, start + files.length);
  const temporaryNames = files.map((name, index) => {
    const temporary = `.__finalizing-${index}-${name}`;
    fs.renameSync(path.join(folder, name), path.join(folder, temporary));
    return temporary;
  });

  for (const [index, temporary] of temporaryNames.entries()) {
    const extension = path.extname(
      temporary.replace(/^\.__finalizing-\d+-/, ""),
    );
    const finalName = `${prefix} ${formatNumber(start + index + 1, padLength)}${extension}`;
    fs.renameSync(path.join(folder, temporary), path.join(folder, finalName));
  }
  return files.length;
}

export function finalizeStandaloneDeliverables(input: {
  messagesDir: string;
  documentsDir: string;
}): FilesDeliverableRenameResult {
  return {
    documents: renameDeliverableFolder(input.documentsDir, "Document"),
    messages: renameDeliverableFolder(input.messagesDir, "Message"),
  };
}

/** Excludes fallback originals below `Unconverted/` from deliverables/upload. */
export function listFinalizedStandaloneDeliverables(input: {
  messagesDir: string;
  documentsDir: string;
}): string[] {
  return [input.messagesDir, input.documentsDir].flatMap((folder) => {
    if (!fs.existsSync(folder)) return [];
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => path.join(folder, entry.name));
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildEmailHtml(rawBody: string, sourceName: string): string {
  const safeBody = escapeHtml(rawBody || "(No body content)");
  return normalizeHtmlForPdf(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(sourceName)}</title>
      </head>
      <body>
        <h2 style="margin: 0 0 12px;">${escapeHtml(sourceName)}</h2>
        <pre style="white-space: pre-wrap; word-break: break-word; margin: 0;">${safeBody}</pre>
      </body>
    </html>
  `);
}

interface ParsedMsgRecipient {
  name?: string;
  email?: string;
  smtpAddress?: string;
  recipType?: string;
}

interface ParsedMsgAttachment {
  contentId?: string;
  contentType?: string;
  fileName?: string;
}

interface ParsedMsgData {
  subject?: string;
  senderName?: string;
  senderSmtpAddress?: string;
  senderEmail?: string;
  recipients?: ParsedMsgRecipient[];
  messageDeliveryTime?: string;
  clientSubmitTime?: string;
  body?: string;
  html?: Uint8Array | string;
  attachments?: ParsedMsgAttachment[];
}

function parseMsg(buffer: Buffer): ParsedMsgData | null {
  try {
    const reader = new MsgReader(
      new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    );
    return reader.getFileData() as ParsedMsgData;
  } catch {
    return null;
  }
}

function contentTypeForMsgAttachment(attachment: ParsedMsgAttachment): string {
  if (attachment.contentType?.startsWith("image/"))
    return attachment.contentType;
  const extension = path.extname(attachment.fileName || "").toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".gif") return "image/gif";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".bmp") return "image/bmp";
  return "image/jpeg";
}

function inlineMsgImages(
  html: string,
  buffer: Buffer,
  message: ParsedMsgData,
): string {
  if (!/\bcid:/i.test(html) || !message.attachments?.length) return html;

  try {
    const reader = new MsgReader(
      new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    );
    let inlined = html;
    for (const attachment of message.attachments) {
      const contentId = attachment.contentId?.replace(/[<>]/g, "");
      if (!contentId) continue;
      const extracted = reader.getAttachment(attachment as FieldsData) as {
        content?: Uint8Array | Buffer | string;
        contentId?: string;
        contentType?: string;
        fileName?: string;
      };
      const content = extracted.content;
      if (!content) continue;
      const bytes = Buffer.isBuffer(content)
        ? content
        : typeof content === "string"
          ? Buffer.from(content)
          : Buffer.from(content);
      const mimeType = contentTypeForMsgAttachment({
        contentType: extracted.contentType || attachment.contentType,
        fileName: extracted.fileName || attachment.fileName,
      });
      const dataUri = `data:${mimeType};base64,${bytes.toString("base64")}`;
      const cid = (extracted.contentId || contentId).replace(/[<>]/g, "");
      inlined = inlined.replace(
        new RegExp(`cid:${escapeRegExp(cid)}`, "gi"),
        dataUri,
      );
    }
    return inlined;
  } catch {
    return html;
  }
}

function buildMsgHtml(
  message: ParsedMsgData,
  sourceName: string,
  sourceBuffer: Buffer,
): string {
  const subject = message.subject || sourceName;
  const sender =
    message.senderSmtpAddress ||
    message.senderEmail ||
    message.senderName ||
    "Unknown";
  const recipients = (message.recipients || [])
    .filter(
      (recipient) =>
        recipient.recipType !== "cc" && recipient.recipType !== "bcc",
    )
    .map(
      (recipient) =>
        recipient.smtpAddress || recipient.email || recipient.name || "",
    )
    .filter(Boolean)
    .join(", ");
  const sentAt =
    message.messageDeliveryTime || message.clientSubmitTime || "Unknown";
  const header = `
    <section style="border-bottom: 2px solid #ddd; padding: 12px; margin-bottom: 18px; background: #f9f9f9;">
      <div><strong>From:</strong> ${escapeHtml(sender)}</div>
      <div><strong>Sent:</strong> ${escapeHtml(sentAt)}</div>
      <div><strong>To:</strong> ${escapeHtml(recipients || "Unknown")}</div>
      <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eaeaea;"><strong>Subject:</strong> ${escapeHtml(subject)}</div>
    </section>`;
  const htmlBody =
    typeof message.html === "string"
      ? message.html
      : message.html instanceof Uint8Array
        ? new TextDecoder("utf-8").decode(message.html)
        : "";

  if (htmlBody) {
    const withHeader = /<body[^>]*>/i.test(htmlBody)
      ? htmlBody.replace(/(<body[^>]*>)/i, `$1${header}`)
      : `${header}${htmlBody}`;
    return normalizeHtmlForPdf(
      inlineMsgImages(withHeader, sourceBuffer, message),
    );
  }

  return normalizeHtmlForPdf(`
    <!DOCTYPE html><html><head><title>${escapeHtml(subject)}</title></head>
    <body>${header}<pre style="white-space: pre-wrap; margin: 0;">${escapeHtml(message.body || "(No body content)")}</pre></body></html>
  `);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function hashFileSha256(filePath: string): Promise<string> {
  // Prefer native hashing in a subprocess to avoid large-file CPU work on the main event loop.
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("shasum", ["-a", "256", filePath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(`shasum failed (${code}): ${stderr || "unknown error"}`),
          );
          return;
        }

        const match = stdout.trim().match(/^([a-fA-F0-9]{64})\s+/);
        if (!match?.[1]) {
          reject(new Error("Unable to parse sha256 output"));
          return;
        }
        resolve(match[1].toLowerCase());
      });
    });
  } catch (_subprocessError) {
    // Fallback to stream hash if shasum is unavailable.
    return await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);

      stream.on("data", (chunk: string | Buffer) => {
        hash.update(chunk);
      });
      stream.on("error", (error) => reject(error));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 180_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms while processing ${label}`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function extractPdfTextInWorker(
  pdfFilePath: string,
  label: string,
  timeoutMs = 45_000,
): Promise<string> {
  const workerCode = `
    const fs = require("node:fs");
    const { parentPort, workerData } = require("node:worker_threads");

    (async () => {
      try {
        const { PDFParse } = await import("pdf-parse");
        const pdfBytes = fs.readFileSync(workerData.pdfFilePath);
        const parser = new PDFParse({ data: pdfBytes });
        try {
          const parsed = await parser.getText();
          parentPort?.postMessage({ ok: true, text: parsed?.text || "" });
        } finally {
          await parser.destroy().catch(() => {});
        }
      } catch (error) {
        parentPort?.postMessage({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  `;

  return await new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { pdfFilePath },
    });

    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(
          new Error(
            `PDF text extraction timed out after ${timeoutMs}ms for ${label}`,
          ),
        );
      });
    }, timeoutMs);

    worker.on(
      "message",
      (msg: { ok?: boolean; text?: string; error?: string }) => {
        if (msg.ok) {
          finish(() => resolve(msg.text || ""));
        } else {
          finish(() =>
            reject(new Error(msg.error || "Unknown PDF extraction error")),
          );
        }
      },
    );

    worker.on("error", (error) => {
      finish(() => reject(error));
    });

    worker.on("exit", (code) => {
      if (done) return;
      finish(() => {
        reject(
          new Error(
            `PDF extraction worker exited unexpectedly with code ${code}`,
          ),
        );
      });
    });
  });
}

interface OfficeConversionOutcome {
  success: boolean;
  passwordProtected: boolean;
  contentKey?: string;
}

// Runs Office (docx/xlsx) parsing in a worker thread. `xlsx.read()` is fully
// synchronous and can block the main worker's event loop hard enough that
// in-process timeouts never fire, so this offloads it to a separate thread we
// can forcibly terminate on timeout.
async function convertOfficeInWorker(
  kind: "docx" | "excel",
  filePath: string,
  outputPath: string,
  criteria: string[],
  docTitle: string,
  bypassFilters = false,
  personalEmail?: string,
  timeoutMs = 150_000,
): Promise<OfficeConversionOutcome> {
  const workerPath = path.resolve(
    process.cwd(),
    "scripts/workers/office-worker.ts",
  );
  // Keep enough headroom for legitimate large workbooks while retaining a
  // deterministic ceiling inside the Files job container.
  const maxOldGenerationSizeMb = Math.max(
    256,
    Number(process.env.OFFICE_WORKER_HEAP_MB || 1024),
  );

  return await new Promise<OfficeConversionOutcome>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      execArgv: ["--import", "tsx"],
      resourceLimits: { maxOldGenerationSizeMb },
      workerData: {
        kind,
        filePath,
        outputPath,
        criteria,
        docTitle,
        bypassFilters,
        personalEmail,
      },
    });

    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(
          new Error(
            `Office conversion timed out after ${timeoutMs}ms for ${docTitle}`,
          ),
        );
      });
    }, timeoutMs);

    worker.on(
      "message",
      (msg: {
        ok?: boolean;
        success?: boolean;
        passwordProtected?: boolean;
        contentKey?: string;
        error?: string;
      }) => {
        if (msg.ok) {
          finish(() =>
            resolve({
              success: Boolean(msg.success),
              passwordProtected: Boolean(msg.passwordProtected),
              contentKey: msg.contentKey,
            }),
          );
        } else {
          finish(() =>
            reject(new Error(msg.error || "Office conversion failed")),
          );
        }
      },
    );

    worker.on("error", (error) => {
      finish(() => reject(error));
    });

    worker.on("exit", (code) => {
      if (done) return;
      finish(() => {
        reject(
          new Error(`Office worker exited unexpectedly with code ${code}`),
        );
      });
    });
  });
}

// Normalizes visible text to a stable dedup key by dropping everything except
// letters and digits, so re-exports that differ only in markup, whitespace,
// punctuation, or element ids collapse to the same key.
function normalizedContentKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Content-level dedup shared by message handlers. Returns true (and does not
// record) when the content is too short to be a reliable signal or when it has
// already been seen; records and returns false for new content. The floor is
// deliberately low so short, byte-identical chat acks ("thanks", "approved")
// re-exported many times collapse to a single deliverable.
function isDuplicateContent(
  text: string,
  processedHashes: Set<string>,
  minLength = 8,
): boolean {
  const key = normalizedContentKey(text);
  if (key.length < minLength) return false;

  const hash = crypto.createHash("sha256").update(key).digest("hex");
  if (processedHashes.has(hash)) return true;

  processedHashes.add(hash);
  return false;
}

function toPlainTextFromHtml(rawHtml: string): string {
  const noScripts = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return noScripts
    .replace(/<[^>]*>?/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Native WeasyPrint renderer to replace Puppeteer
async function renderHtmlToPdfWeasyPrint(
  htmlContent: string,
  outputPath: string,
  label: string,
  timeoutMs = 90_000,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "weasyprint-standalone-"),
  );
  const htmlPath = path.join(
    tmpDir,
    `temp_${crypto.randomBytes(4).toString("hex")}.html`,
  );

  fs.writeFileSync(htmlPath, normalizeHtmlForPdf(htmlContent), "utf-8");

  const baseUrl = pathToFileURL(process.cwd()).toString();

  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "weasyprint",
      ["-q", "-e", "utf-8", "--base-url", baseUrl, htmlPath, outputPath],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`WeasyPrint timed out after ${timeoutMs}ms for ${label}`),
      );
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        // Reject empty output so callers don't ship 0-byte PDFs.
        let sizeOk = false;
        try {
          sizeOk =
            fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
        } catch {
          sizeOk = false;
        }
        if (sizeOk) {
          resolve();
        } else {
          try {
            fs.rmSync(outputPath, { force: true });
          } catch {
            // Ignore cleanup races.
          }
          reject(new Error(`WeasyPrint produced an empty PDF for ${label}`));
        }
        return;
      }
      reject(
        new Error(
          `WeasyPrint failed for ${label} with exit code ${code} (Signal: ${signal}): ${stderr}`,
        ),
      );
    });
  }).finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

export interface StandaloneBatchProgress {
  processed: number;
  skipped: number;
  duplicates: number;
  index: number;
  total: number;
  outputPath?: string;
}

export async function runStandaloneBatch(
  params: StandaloneBatchParams,
  onProgress?: (progress: StandaloneBatchProgress) => void,
): Promise<StandaloneBatchResult> {
  const { inputDir, messagesDir, documentsDir, subjectCriteria } = params;

  if (!inputDir || (!params.clientMode && !subjectCriteria?.name)) {
    return {
      success: false,
      error: "Missing inputDir or subjectCriteria.name",
    };
  }

  // 1. Build Criteria & Exclusion Arrays (Added trim for safety)
  const aliases = subjectCriteria.aliases || [];
  const subjectEmail = (subjectCriteria.personalEmail || "")
    .trim()
    .toLowerCase();
  // One token set for every item type (see src/lib/subject-rules.ts).
  const criteria = buildSubjectTokens({
    name: subjectCriteria.name,
    email: subjectCriteria.email,
    personalEmail: subjectCriteria.personalEmail,
    aliases,
  });
  const subjectNameTokens = criteria;
  // Spreadsheets deliver whole rows, so they only match full identifiers.
  const sheetCriteria = buildSubjectIdentifiers({
    name: subjectCriteria.name,
    email: subjectCriteria.email,
    personalEmail: subjectCriteria.personalEmail,
    aliases,
  });

  // Shared privileged/confidential keyword filter (see src/lib/exclusions.ts)
  // so the Files pipeline stays in lockstep with the PST pipeline.
  const bypassFilters = params.clientMode === true;
  const renderingCriteria = bypassFilters ? [] : criteria;

  // Every filter discard goes through here: it keeps the log line the operators
  // read and tells the audit trail which rule decided.
  // Per-message decisions of the chat export being judged, handed to the next
  // decision reported for that file.
  let chatMessageDecisions: ChildItemDecision[] | undefined;
  let imageKeepReason: string | undefined;
  const recordDiscard = (
    filePath: string,
    text: string,
    by?: { rule: string; decidedBy: string },
  ) => {
    console.log(`[Standalone Filter] ${text}`);
    try {
      params.onDecision?.({
        filePath,
        state: "discarded",
        rule: by?.rule ?? fileDiscardRule(text),
        ...(by ? { decidedBy: by.decidedBy } : {}),
        reason: text.replace(/^Discarded\s+/, ""),
        ...(chatMessageDecisions?.length
          ? { messages: chatMessageDecisions }
          : {}),
      });
    } catch (error) {
      console.warn("[Standalone Filter] Audit trail callback failed:", error);
    }
  };

  const standaloneStagingDir = inputDir;
  const deliverablesDirMessages = messagesDir;
  const deliverablesDirDocuments = documentsDir;

  if (!fs.existsSync(standaloneStagingDir)) {
    return {
      success: false,
      error: `No input directory found at ${standaloneStagingDir}`,
    };
  }

  // Ensure output directories exist
  if (!fs.existsSync(deliverablesDirMessages))
    fs.mkdirSync(deliverablesDirMessages, { recursive: true });
  if (!fs.existsSync(deliverablesDirDocuments))
    fs.mkdirSync(deliverablesDirDocuments, { recursive: true });

  let processedCount = 0;
  let skippedCount = 0;
  let duplicatesCount = 0;

  console.log(`\n=================================================`);
  console.log(`[Standalone Engine] Scanning: ${standaloneStagingDir}`);
  console.log(
    `[Standalone Engine] Saving to: ${deliverablesDirMessages} and ${deliverablesDirDocuments}`,
  );
  console.log(`=================================================\n`);

  // Retrieve all files recursively
  const allFiles =
    params.filePaths || listStandaloneInputFiles(standaloneStagingDir);
  console.log(
    `[Standalone Engine] Found ${allFiles.length} files to evaluate (recursively).`,
  );

  // In-memory set to track hashes for deduplication
  const processedHashes = new Set<string>();

  let fileIndex = 0;
  for (const filePath of allFiles) {
    fileIndex++;
    const file = path.basename(filePath);
    chatMessageDecisions = undefined;
    imageKeepReason = undefined;

    // Skip hidden system files and JSON metadata files
    if (file.startsWith(".") || file.toLowerCase().endsWith(".json")) continue;

    // A laptop sleep can interrupt a batch after it has created a verified
    // deliverable and reclaimed its source, but before the batch's result was
    // durably acknowledged. Its retry receives the original manifest, so a
    // missing source here is an already-completed item, not a new failure.
    if (!fs.existsSync(filePath)) {
      processedCount++;
      console.log(
        `[Standalone Engine] Already completed before retry: ${file}`,
      );
      continue;
    }

    console.log(
      `[Standalone Engine] (${fileIndex}/${allFiles.length}) Processing: ${file}`,
    );

    onProgress?.({
      processed: processedCount,
      skipped: skippedCount,
      duplicates: duplicatesCount,
      index: fileIndex,
      total: allFiles.length,
    });

    try {
      // Yield between files so the worker process stays cooperative.
      await yieldToEventLoop();

      const ext = path.extname(file).toLowerCase();

      // A file that needs a password to open is confidential: it is discarded
      // in every case type (client included), whatever its format.
      if (isPasswordProtectedFile(filePath)) {
        recordDiscard(
          filePath,
          `Discarded ${file}: Password-protected/encrypted file.`,
        );
        skippedCount++;
        continue;
      }

      // A privileged/confidential keyword in the name of a document discards it,
      // as it does in the name of an email attachment. Chat and mail exports are
      // judged by their content instead.
      if (
        !bypassFilters &&
        !MESSAGE_EXTENSIONS.has(ext) &&
        hasPrivilegedKeywordInFileName(file)
      ) {
        recordDiscard(
          filePath,
          `Discarded ${ext.toUpperCase()} ${file}: Contains excluded keyword in the file name.`,
        );
        skippedCount++;
        continue;
      }

      // --- CRYPTOGRAPHIC DEDUPLICATION CHECK ---
      const fileHash = await withTimeout(
        hashFileSha256(filePath),
        `${file} hash`,
        120_000,
      );
      if (processedHashes.has(fileHash)) {
        recordDiscard(
          filePath,
          `Discarded Duplicate ${file} (Hash: ${fileHash.substring(0, 8)})`,
        );
        duplicatesCount++;
        skippedCount++; // Count as skipped for the UI
        continue;
      }

      // Only read the file into memory for handlers that run in-process
      // (HTML/EML/MSG). PDFs and Office documents are parsed in separate worker
      // threads so their heavy/synchronous parsing can't block this loop.
      const inProcessExts = new Set([".html", ".htm", ".eml", ".msg", ".txt"]);
      const buffer = inProcessExts.has(ext)
        ? await withTimeout(
            fs.promises.readFile(filePath),
            `${file} read`,
            60_000,
          )
        : undefined;

      let success = false;
      let producedPath: string | null = null;
      let semanticContentKey: string | undefined;
      let targetDir = deliverablesDirDocuments;
      let isMessage = false;

      // Route files to appropriate folders
      if (MESSAGE_EXTENSIONS.has(ext)) {
        targetDir = deliverablesDirMessages;
        isMessage = true;
      }

      // A hash-based name is stable and collision-free across parallel batch
      // workers. Sequential names only work when a single process owns a case.
      const seqName = isMessage
        ? `Message ${fileHash.slice(0, 16)}`
        : `Document ${fileHash.slice(0, 16)}`;

      const pdfOutputPath = path.join(targetDir, `${seqName}.pdf`);

      // --- HANDLER 1: Word Documents ---
      if (ext === ".docx" || ext === ".doc") {
        const outcome = await convertOfficeInWorker(
          "docx",
          filePath,
          pdfOutputPath,
          renderingCriteria,
          seqName,
          bypassFilters,
          subjectEmail,
        );
        if (outcome.passwordProtected) {
          recordDiscard(
            filePath,
            `Discarded ${ext.toUpperCase()} ${file}: Password-protected/encrypted file.`,
          );
          skippedCount++;
          continue;
        }
        success = outcome.success;
        semanticContentKey = outcome.contentKey;
        if (success) producedPath = pdfOutputPath;
      }

      // --- HANDLER 2: Excel Spreadsheets ---
      else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
        // Opening a very large workbook can need more memory than a worker has
        // and gets the whole worker killed, so first stream its text and drop
        // it when the subject cannot appear in it. The conversion keeps a sheet
        // only if a cell holds one of these criteria, so this drops exactly
        // what the conversion would have dropped, in seconds. When the scan
        // cannot tell, the normal conversion runs.
        if (
          sheetCriteria.length > 0 &&
          shouldPrescreenSpreadsheet(
            ext,
            fs.statSync(filePath).size,
            prescreenThresholdMb(),
          )
        ) {
          const scan = await scanXlsxForMentions(filePath, sheetCriteria);
          if (scan.status === "not-mentioned") {
            recordDiscard(
              filePath,
              `Discarded ${ext.toUpperCase()} ${file}: the subject is not mentioned anywhere in this large workbook (streamed scan).`,
            );
            skippedCount++;
            continue;
          }
        }
        // Spreadsheets are filtered by the subject in every case type, client
        // included: only the rows that mention the subject are delivered (whole
        // rows), and a workbook that never mentions it is dropped. Client cases
        // still skip the privileged-keyword exclusion (`bypassFilters`): the AI
        // screening decides on confidentiality there.
        const outcome = await convertOfficeInWorker(
          "excel",
          filePath,
          pdfOutputPath,
          sheetCriteria,
          seqName,
          bypassFilters,
          subjectEmail,
        );
        if (outcome.passwordProtected) {
          recordDiscard(
            filePath,
            `Discarded ${ext.toUpperCase()} ${file}: Password-protected/encrypted file.`,
          );
          skippedCount++;
          continue;
        }
        success = outcome.success;
        semanticContentKey = outcome.contentKey;
        if (success) producedPath = pdfOutputPath;
      }

      // --- HANDLER 3: Teams chats and other HTML (docs/pipeline-refactor.md, 4.3) ---
      // A Teams export is judged message by message: the messages that cite the
      // subject are kept with two messages of context on each side, the keyword
      // rule applies to each excerpt, and only the excerpts are rendered. HTML
      // that is not a chat export is an ordinary document. Client cases keep the
      // whole conversation, as before.
      else if (ext === ".html" || ext === ".htm") {
        if (!buffer) {
          skippedCount++;
          continue;
        }
        const rawHtml = buffer.toString("utf-8");
        const rawPlainText = toPlainTextFromHtml(rawHtml);
        const plainText = stripEmailSignature(rawPlainText);
        const chatMessages = bypassFilters ? [] : parseChatMessages(rawHtml);
        chatMessageDecisions = undefined;
        let htmlToRender = rawHtml;
        let discardNote: string | null = null;

        if (bypassFilters) {
          if (isDuplicateContent(plainText, processedHashes)) {
            discardNote = "duplicate";
          }
        } else if (chatMessages.length > 0) {
          const excerpts = buildExcerpts(
            chatMessages,
            subjectNameTokens,
            CHAT_CONTEXT_MESSAGES,
            // A message already delivered from another export of the chat is
            // not a candidate again.
            (message) => processedHashes.has(messageKey(message)),
          );
          const citing = chatMessages.filter(
            (message) =>
              messageCitesSubject(message, subjectNameTokens) &&
              !processedHashes.has(messageKey(message)),
          ).length;
          const kept = excerpts.filter((excerpt) => {
            const text = excerptText(excerpt);
            return !(
              hasPrivilegedKeywordInDocument(text) &&
              !textShowsSentToPersonalAddress(text, subjectEmail)
            );
          });
          // What happened to each message that cites the subject, for the audit trail.
          const keptIds = new Set<string>();
          const droppedIds = new Set<string>();
          for (const excerpt of excerpts) {
            const target = kept.includes(excerpt) ? keptIds : droppedIds;
            for (const id of excerpt.candidateIds) target.add(id);
          }
          chatMessageDecisions = [];
          chatMessages.forEach((message, index) => {
            if (!messageCitesSubject(message, subjectNameTokens)) return;
            const base = {
              key: messageKey(message),
              label: `Message ${index + 1} of ${chatMessages.length}`,
            };
            if (keptIds.has(message.id)) {
              chatMessageDecisions?.push({
                ...base,
                state: "kept",
                rule: "chat_excerpt",
                reason: "Cites the subject; kept with the messages around it.",
              });
            } else if (droppedIds.has(message.id)) {
              chatMessageDecisions?.push({
                ...base,
                state: "discarded",
                rule: "keyword",
                reason: "Contains excluded keyword.",
              });
            } else {
              chatMessageDecisions?.push({
                ...base,
                state: "discarded",
                rule: "dup",
                reason:
                  "The same message was already delivered from another export.",
              });
            }
          });
          if (excerpts.length === 0) {
            discardNote = chatMessages.some((message) =>
              messageCitesSubject(message, subjectNameTokens),
            )
              ? "duplicate"
              : "not-mentioned";
          } else if (kept.length === 0) {
            discardNote = "keyword";
          } else {
            for (const excerpt of kept) {
              for (const id of excerpt.candidateIds) {
                const message = excerpt.messages.find((m) => m.id === id);
                if (message) processedHashes.add(messageKey(message));
              }
            }
            console.log(
              `[Standalone Filter] ${file}: kept ${kept.length} excerpt(s) around ${citing} message(s) citing the subject (of ${chatMessages.length}).`,
            );
            htmlToRender = renderExcerptsHtml(file, chatMessages.length, kept);
          }
        } else if (
          hasPrivilegedKeywordInDocument(plainText) &&
          !textShowsSentToPersonalAddress(rawPlainText, subjectEmail)
        ) {
          discardNote = "keyword";
        } else if (!mentionsSubject(plainText, subjectNameTokens)) {
          discardNote = "not-mentioned";
        } else if (isDuplicateContent(plainText, processedHashes)) {
          discardNote = "duplicate";
        }

        if (discardNote === "keyword") {
          recordDiscard(
            filePath,
            `Discarded HTML ${file}: Contains excluded keyword.`,
          );
        } else if (discardNote === "not-mentioned") {
          recordDiscard(
            filePath,
            `Discarded HTML ${file}: Data subject not mentioned.`,
          );
        } else if (discardNote === "duplicate") {
          recordDiscard(
            filePath,
            `Discarded Duplicate HTML ${file} (Content Match).`,
          );
          duplicatesCount++;
          skippedCount++;
          continue;
        } else {
          try {
            await withTimeout(
              renderHtmlToPdfWeasyPrint(
                normalizeHtmlForPdf(htmlToRender),
                pdfOutputPath,
                seqName,
              ),
              file,
            );
            success = true;
            producedPath = pdfOutputPath;
          } catch (_e) {
            console.warn(
              `[Standalone Filter] Failed to render HTML to PDF: ${file}. Saving raw HTML instead as fallback.`,
            );

            // Preserve the source HTML when rendering fails.
            const fallbackPath = path.join(targetDir, `${seqName}${ext}`);
            await fs.promises.copyFile(filePath, fallbackPath);
            success = true;
            producedPath = fallbackPath;
          }
        }
      }

      // --- HANDLER 4: Outlook MSG & EML Files ---
      else if (ext === ".msg" || ext === ".eml") {
        if (!buffer) {
          skippedCount++;
          continue;
        }
        const parsedMsg = ext === ".msg" ? parseMsg(buffer) : null;
        // MSG files are Compound File Binary containers, not text. Use their
        // parsed mail body for filtering and rendering; decoding container
        // bytes was producing pages of replacement glyphs in the PDF.
        const rawText = stripEmailSignature(
          parsedMsg
            ? `${parsedMsg.subject || ""}\n${parsedMsg.body || ""}`
            : `${buffer.toString("utf-8")} ${buffer.toString("utf16le")}`.replace(
                /\0/g,
                " ",
              ),
        );

        // The same rules as every PST email (docs/pipeline-refactor.md, 4.1):
        // read the message itself, not its raw bytes, so encoded bodies and
        // headers are judged on what the person would read.
        let parsedEml: Awaited<ReturnType<typeof simpleParser>> | null = null;
        if (ext === ".eml") {
          try {
            parsedEml = await withTimeout(simpleParser(buffer), file);
          } catch {
            parsedEml = null;
          }
        }
        const addressesOf = (
          value: Awaited<ReturnType<typeof simpleParser>>["to"],
        ): string[] =>
          (Array.isArray(value) ? value : value ? [value] : [])
            .flatMap((container) => container.value ?? [])
            .map((entry) => entry.address ?? "")
            .filter(Boolean);
        const mailSubject = parsedEml
          ? parsedEml.subject || ""
          : parsedMsg
            ? parsedMsg.subject || ""
            : "";
        const mailBody = parsedEml
          ? parsedEml.text || ""
          : parsedMsg
            ? parsedMsg.body || ""
            : rawText;
        const mailHeaders = parsedEml
          ? [
              parsedEml.from?.text,
              parsedEml.to && "text" in parsedEml.to ? parsedEml.to.text : "",
            ].join(" ")
          : parsedMsg
            ? [
                parsedMsg.senderName,
                parsedMsg.senderEmail,
                parsedMsg.senderSmtpAddress,
                ...(parsedMsg.recipients ?? []).map(
                  (r) => `${r.name ?? ""} ${r.email ?? ""}`,
                ),
              ].join(" ")
            : "";
        const mailRecipients = parsedEml
          ? [
              ...addressesOf(parsedEml.to),
              ...addressesOf(parsedEml.cc),
              ...addressesOf(parsedEml.bcc),
            ]
          : (parsedMsg?.recipients ?? []).map(
              (r) => r.email ?? r.smtpAddress ?? "",
            );
        const sentToSubjectEmail =
          isSentToPersonalAddress(mailRecipients, subjectEmail) ||
          textShowsSentToPersonalAddress(rawText, subjectEmail);
        // A parsed .eml gets exactly the decision the PST analyzer makes.
        const keywordDiscard = parsedEml
          ? discardedForKeyword(parsedEml, subjectEmail)
          : hasPrivilegedKeyword(mailSubject, mailBody) && !sentToSubjectEmail;
        const containsSubjectName = mentionsSubject(
          `${mailHeaders}\n${mailSubject}\n${mailBody}\n${rawText}`,
          subjectNameTokens,
        );

        if (!bypassFilters && keywordDiscard) {
          recordDiscard(
            filePath,
            `Discarded ${ext.toUpperCase()} ${file}: Contains excluded keyword.`,
          );
        } else if (!bypassFilters && !containsSubjectName) {
          recordDiscard(
            filePath,
            `Discarded ${ext.toUpperCase()} ${file}: Data subject not mentioned.`,
          );
        } else {
          const pdfOutput = path.join(targetDir, `${seqName}.pdf`);

          if (ext === ".eml") {
            const parsed = parsedEml;

            // Dedup on a clean key built from the envelope + body text so that
            // re-exports of the same email collapse even if raw bytes differ.
            const dedupSource = parsed
              ? `${parsed.subject || ""} ${parsed.from?.text || ""} ${parsed.text || parsed.html || ""}`
              : rawText;
            if (isDuplicateContent(dedupSource, processedHashes)) {
              recordDiscard(
                filePath,
                `Discarded Duplicate EML ${file} (Content Match).`,
              );
              duplicatesCount++;
              skippedCount++;
              continue;
            }

            try {
              const emailBody = parsed
                ? parsed.html || parsed.textAsHtml || parsed.text || rawText
                : rawText;
              await withTimeout(
                renderHtmlToPdfWeasyPrint(
                  normalizeHtmlForPdf(String(emailBody)),
                  pdfOutput,
                  seqName,
                ),
                file,
              );
            } catch (_e) {
              // Fallback for malformed EML payloads.
              await withTimeout(
                renderHtmlToPdfWeasyPrint(
                  buildEmailHtml(rawText, file),
                  pdfOutput,
                  seqName,
                ),
                file,
              );
            }
            success = true;
            producedPath = pdfOutput;
          } else {
            // MSG files require structured parsing: their raw bytes are an OLE
            // container, not a printable text representation.
            if (isDuplicateContent(rawText, processedHashes)) {
              recordDiscard(
                filePath,
                `Discarded Duplicate MSG ${file} (Content Match).`,
              );
              duplicatesCount++;
              skippedCount++;
              continue;
            }
            await withTimeout(
              renderHtmlToPdfWeasyPrint(
                parsedMsg
                  ? buildMsgHtml(parsedMsg, file, buffer)
                  : buildEmailHtml(rawText, file),
                pdfOutput,
                seqName,
              ),
              file,
            );
            success = true;
            producedPath = pdfOutput;
          }
        }
      }

      // --- HANDLER 5: Plain-text documents ---
      else if (ext === ".txt") {
        if (!buffer) {
          skippedCount++;
          continue;
        }
        const rawText = buffer.toString("utf-8");
        const reason = await withTimeout(
          processTextToPdf(
            rawText,
            pdfOutputPath,
            criteria,
            seqName,
            (text) => isDuplicateContent(text.toLowerCase(), processedHashes),
            bypassFilters,
            subjectEmail,
          ),
          file,
        );
        if (reason === "keyword") {
          recordDiscard(
            filePath,
            `Discarded TXT ${file}: Contains excluded keyword.`,
          );
        } else if (reason === "subject_absent") {
          recordDiscard(
            filePath,
            `Discarded TXT ${file}: Data subject not mentioned.`,
          );
        } else if (reason === "duplicate") {
          recordDiscard(
            filePath,
            `Discarded Duplicate TXT ${file} (Content Match).`,
          );
          duplicatesCount++;
          skippedCount++;
          continue;
        } else {
          success = true;
          producedPath = pdfOutputPath;
        }
      }

      // --- HANDLER 6: Raw PDFs ---
      else if (ext === ".pdf") {
        try {
          const rawText = (
            await extractPdfTextInWorker(filePath, file, 45_000)
          ).toLowerCase();

          if (!bypassFilters && hasPrivilegedKeywordInDocument(rawText)) {
            recordDiscard(
              filePath,
              `Discarded PDF ${file}: Contains excluded keyword.`,
            );
          } else if (!bypassFilters && !mentionsSubject(rawText, criteria)) {
            recordDiscard(
              filePath,
              `Discarded PDF ${file}: Data subject not mentioned.`,
            );
          } else {
            // Additional semantic hash check for content-level duplicate PDFs.
            const textHash = crypto
              .createHash("sha256")
              .update(rawText)
              .digest("hex");
            if (processedHashes.has(textHash)) {
              recordDiscard(
                filePath,
                `Discarded Duplicate PDF ${file} (Content Match).`,
              );
              duplicatesCount++;
              skippedCount++;
              continue;
            }
            processedHashes.add(textHash);

            await fs.promises.copyFile(filePath, pdfOutputPath);
            success = true;
            producedPath = pdfOutputPath;
          }
        } catch (pdfError) {
          if (isPasswordProtectionError(pdfError)) {
            recordDiscard(
              filePath,
              `Discarded PDF ${file}: Password-protected/encrypted file.`,
            );
            skippedCount++;
            continue;
          }
          console.warn(
            `[Standalone Filter] Failed/timed out parsing PDF ${file}. Saving raw file as fallback.`,
          );
          await fs.promises.copyFile(filePath, pdfOutputPath);
          success = true;
          producedPath = pdfOutputPath;
        }
      }

      // --- HANDLER 7: Images ---
      // A signature or decoration is dropped with the signal that decided; any
      // other image becomes a PDF without text, which the screening step sends
      // to a person (nothing reads images automatically yet).
      else if (
        IMAGE_EXTENSIONS.has(ext) ||
        UNRENDERABLE_IMAGE_EXTENSIONS.has(ext)
      ) {
        let imageBuffer: Buffer = await withTimeout(
          fs.promises.readFile(filePath),
          `${file} read`,
          60_000,
        );
        if (UNRENDERABLE_IMAGE_EXTENSIONS.has(ext)) {
          // BMP, TIFF and HEIC become a PNG first; one that cannot be
          // converted is unreadable, like any other broken image.
          imageBuffer =
            (await convertImageToPng(imageBuffer, ext)) ?? Buffer.alloc(0);
        }
        const facts = readImageFacts(imageBuffer);
        if (!facts) {
          recordDiscard(
            filePath,
            `Discarded ${ext.toUpperCase()} ${file}: unreadable image.`,
          );
          skippedCount++;
          continue;
        }
        const verdict = classifyImage(file, facts);
        if (verdict.kind === "signature") {
          recordDiscard(
            filePath,
            `Discarded ${ext.toUpperCase()} ${file}: signature image (${verdict.signal}).`,
          );
          skippedCount++;
          continue;
        }
        if (verdict.kind === "ambiguous") {
          const vision = await judgeImageWithVision(imageBuffer, {
            enabled: await visionEnabled(),
          });
          if (vision.verdict === "decoration") {
            recordDiscard(
              filePath,
              `Discarded ${ext.toUpperCase()} ${file}: signature image (vision model, ${vision.reason}).`,
            );
            skippedCount++;
            continue;
          }
        }
        if (params.judgeImage) {
          const judged = await params.judgeImage(imageBuffer);
          if (judged.verdict === "discard") {
            recordDiscard(
              filePath,
              `Discarded ${ext.toUpperCase()} ${file}: image read by the AI (${judged.reason}).`,
              { rule: "ai_file", decidedBy: "ai" },
            );
            skippedCount++;
            continue;
          }
          if (judged.verdict === "keep") imageKeepReason = judged.reason;
        }
        await withTimeout(
          processImageToPdf(imageBuffer, pdfOutputPath, seqName),
          file,
        );
        success = true;
        producedPath = pdfOutputPath;
      }

      // Formats the renderer cannot handle (video, audio...) are never
      // delivered, in any case type.
      else {
        recordDiscard(
          filePath,
          `Discarded ${ext.toUpperCase() || "(no extension)"} ${file}: unsupported format${mediaKind(ext) ? ` (${mediaKind(ext)} is never delivered)` : ""}.`,
        );
        skippedCount++;
        continue;
      }

      // A client case must still deliver a unique source that cannot be
      // rendered (for example a malformed message). Password-protected files never
      // get here: they are discarded up front in every case type.
      // Keep it in its natural output category with a collision-safe name.
      // A spreadsheet is never delivered as an original: when it renders
      // nothing, the subject is not in it (or it duplicates another), so it is
      // dropped.
      if (!success && (ext === ".xlsx" || ext === ".xls" || ext === ".csv")) {
        skippedCount++;
        continue;
      }
      if (bypassFilters && !success) {
        const fallbackPath = path.join(targetDir, `${seqName}${ext}`);
        await fs.promises.copyFile(filePath, fallbackPath);
        success = true;
        producedPath = fallbackPath;
      }

      // Guard against 0-byte / corrupted deliverables. WeasyPrint can leave an
      // empty output file when it is killed on timeout or fails mid-write.
      const removeIfEmpty = (candidate: string | null | undefined) => {
        if (!candidate) return false;
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).size === 0) {
            fs.rmSync(candidate, { force: true });
            return true;
          }
        } catch {
          // Ignore filesystem races; treat as not-removed.
        }
        return false;
      };

      // Always clean a stray empty PDF (e.g. leftover from a failed render).
      if (pdfOutputPath !== producedPath) {
        removeIfEmpty(pdfOutputPath);
      }

      // If the actual deliverable is empty, drop it and count as skipped.
      if (success && producedPath) {
        const isEmpty =
          !fs.existsSync(producedPath) || fs.statSync(producedPath).size === 0;
        if (isEmpty) {
          removeIfEmpty(producedPath);
          success = false;
          recordDiscard(
            filePath,
            `Discarded ${file}: produced a 0-byte/empty output.`,
          );
        }
      }

      // Office containers can differ by metadata, revision history, or a
      // workbook id while yielding the exact same visible document. Dedup on
      // the normalized workbook content as well as the source bytes.
      if (success && semanticContentKey) {
        if (processedHashes.has(semanticContentKey)) {
          fs.rmSync(producedPath || pdfOutputPath, { force: true });
          recordDiscard(
            filePath,
            `Discarded Duplicate ${file} (matching Office content).`,
          );
          duplicatesCount++;
          skippedCount++;
          continue;
        }
        processedHashes.add(semanticContentKey);
      }

      // Tally results and increment counters only on success
      if (success) {
        processedHashes.add(fileHash); // Lock this hash so future duplicates are dropped
        processedCount++;
        if (producedPath) {
          try {
            params.onDecision?.({
              filePath,
              state: "kept",
              rule: "files_filter",
              reason: "Passed the file filters.",
              deliveredRel: `${path.basename(path.dirname(producedPath))}/${path.basename(producedPath)}`,
              ...(imageKeepReason
                ? {
                    aiVerdict: {
                      verdict: "keep" as const,
                      reason: imageKeepReason,
                    },
                  }
                : {}),
              ...(chatMessageDecisions?.length
                ? { messages: chatMessageDecisions }
                : {}),
            });
          } catch (error) {
            console.warn(
              "[Standalone Filter] Audit trail callback failed:",
              error,
            );
          }
        }
        console.log(`[Standalone Engine] Exported: ${seqName}.pdf`);
        onProgress?.({
          processed: processedCount,
          skipped: skippedCount,
          duplicates: duplicatesCount,
          index: fileIndex,
          total: allFiles.length,
          outputPath: producedPath || undefined,
        });

        // The deliverable has passed the non-empty output guard above. Reclaim
        // the original staged MSG/EML/document/spreadsheet immediately rather
        // than holding all source files until the Files phase ends.
        try {
          fs.rmSync(filePath, { force: true });
        } catch (cleanupError) {
          console.warn(
            `[Standalone Engine] Could not reclaim source ${file}:`,
            cleanupError,
          );
        }
      } else {
        skippedCount++;
      }
    } catch (fileError) {
      console.error(`[Standalone Engine] Failed file ${filePath}:`, fileError);
      skippedCount++;
    }
  }

  console.log(
    `\n[Standalone Engine] Finished! Processed: ${processedCount} | Dropped: ${skippedCount} (Duplicates: ${duplicatesCount})\n`,
  );

  return {
    success: true,
    message: `Standalone batch completed. Deduplicated ${duplicatesCount} identical files.`,
    processedCount,
    skippedCount,
    duplicatesCount,
  };
}
