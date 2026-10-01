import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";
import { simpleParser } from "mailparser";
import { normalizeHtmlForPdf } from "./converter";
import { stripEmailSignature } from "./email-content";
import { PRIVILEGED_KEYWORDS_RE } from "./exclusions";

export interface StandaloneBatchParams {
  inputDir: string;
  /** A dispatcher-provided slice of the input tree for parallel batch jobs. */
  filePaths?: string[];
  messagesDir: string;
  documentsDir: string;
  subjectCriteria: { name: string; personalEmail?: string; aliases?: string[] };
  /** Client cases retain all unique content, without relevance exclusions. */
  clientMode?: boolean;
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
}): Promise<UnconvertedFilesResult> {
  let copied = 0;
  let missing = 0;

  for (const filePath of input.filePaths) {
    if (!fs.existsSync(filePath)) {
      missing++;
      continue;
    }
    const extension = path.extname(filePath).toLowerCase();
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

  return { copied, missing };
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
 * Two-stage renaming makes the operation safe even when a target name already
 * exists from a previous attempt.
 */
function renameDeliverableFolder(folder: string, prefix: string): number {
  if (!fs.existsSync(folder)) return 0;
  const files = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // Keep names compact while preserving natural lexical ordering: 1–9 needs
  // no padding, 10–99 needs two digits, and so on.
  const padLength = String(Math.max(1, files.length)).length;
  const temporaryNames = files.map((name, index) => {
    const temporary = `.__finalizing-${index}-${name}`;
    fs.renameSync(path.join(folder, name), path.join(folder, temporary));
    return temporary;
  });

  for (const [index, temporary] of temporaryNames.entries()) {
    const extension = path.extname(
      temporary.replace(/^\.__finalizing-\d+-/, ""),
    );
    const finalName = `${prefix} ${String(index + 1).padStart(padLength, "0")}${extension}`;
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

function buildTextDocumentHtml(rawText: string, sourceName: string): string {
  return normalizeHtmlForPdf(`
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8" /><title>${escapeHtml(sourceName)}</title></head>
      <body>
        <h2>${escapeHtml(sourceName)}</h2>
        <pre style="white-space: pre-wrap; overflow-wrap: anywhere; font-family: sans-serif;">${escapeHtml(rawText)}</pre>
      </body>
    </html>
  `);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isPasswordProtectionError(error: unknown): boolean {
  const msg = String(
    error instanceof Error ? error.message : error,
  ).toLowerCase();
  return /(password|passphrase|encrypted|encryption|decrypt|protected)/.test(
    msg,
  );
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

function buildSubjectNameTokens(
  subjectName: string,
  aliases: string[] = [],
): string[] {
  const cleanedName = subjectName.trim().replace(/\s+/g, " ");
  const parts = cleanedName.split(" ").filter(Boolean);

  const tokens = new Set<string>();
  if (cleanedName) tokens.add(cleanedName.toLowerCase());

  if (parts.length > 0) {
    const firstName = parts[0].toLowerCase();
    const surname = parts[parts.length - 1].toLowerCase();
    if (firstName.length >= 4) tokens.add(firstName);
    if (surname.length >= 4) tokens.add(surname);
  }

  for (const alias of aliases) {
    const cleanAlias = alias.trim().replace(/\s+/g, " ").toLowerCase();
    if (cleanAlias) tokens.add(cleanAlias);
  }

  return Array.from(tokens).filter(Boolean);
}

function textContainsAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => {
    const pattern = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(token)}($|[^a-z0-9])`,
      "i",
    );
    return pattern.test(text);
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

function isAuthoredBySubject(
  plainText: string,
  subjectTokens: string[],
): boolean {
  return subjectTokens.some((token) => {
    const t = escapeRegExp(token);
    const authoredPatterns = [
      new RegExp(`\\b(from|sender|author|by)\\s*[:\\-]?\\s*${t}\\b`, "i"),
      new RegExp(`\\b${t}\\b\\s*(said|posted|sent|wrote)\\b`, "i"),
      new RegExp(`\\bmessage from\\s+${t}\\b`, "i"),
      // Teams export line style: "Full Name <email@domain> 3/12/2025 10:06 PM"
      new RegExp(
        `\\b${t}\\b\\s*<[^>\\n]{1,120}@[^>\\n]{1,120}>\\s+\\d{1,2}[/\\-]\\d{1,2}[/\\-]\\d{2,4}`,
        "i",
      ),
      // Broader fallback for sender signatures in chat exports
      new RegExp(`\\b${t}\\b\\s*<[^>\\n]{1,120}@[^>\\n]{1,120}>`, "i"),
    ];
    return authoredPatterns.some((re) => re.test(plainText));
  });
}

function isDirectReplyToSubject(
  plainText: string,
  subjectTokens: string[],
): boolean {
  return subjectTokens.some((token) => {
    const t = escapeRegExp(token);
    const replyPatterns = [
      new RegExp(`\\brepl(?:y|ied|ying)\\s+to\\s+${t}\\b`, "i"),
      new RegExp(`\\bin\\s+reply\\s+to\\s+${t}\\b`, "i"),
      new RegExp(`\\brespond(?:ed|ing)?\\s+to\\s+${t}\\b`, "i"),
      new RegExp(`\\b(replying\\s+to|replied\\s+to)\\s+${t}\\b`, "i"),
    ];
    return replyPatterns.some((re) => re.test(plainText));
  });
}

function stripLikelyHeaderMentions(
  plainText: string,
  subjectTokens: string[],
): string {
  let sanitized = plainText;
  for (const token of subjectTokens) {
    const t = escapeRegExp(token);
    sanitized = sanitized.replace(
      new RegExp(
        `\\b(from|sender|author|by|to|cc|bcc)\\s*[:\\-]?\\s*${t}\\b`,
        "gi",
      ),
      " ",
    );
    sanitized = sanitized.replace(
      new RegExp(`\\bmessage\\s+from\\s+${t}\\b`, "gi"),
      " ",
    );
    sanitized = sanitized.replace(
      new RegExp(`\\b${t}\\b\\s*(said|posted|sent|wrote)\\b`, "gi"),
      " ",
    );
  }
  return sanitized.replace(/\s+/g, " ").trim();
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

function toStructuredPlainTextFromHtml(rawHtml: string): string {
  const noScripts = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  // Preserve likely line boundaries so sender headers remain detectable.
  const withBreaks = noScripts.replace(
    /<\s*\/?\s*(br|p|div|li|tr|h[1-6]|section|article|header|footer)\b[^>]*>/gi,
    "\n",
  );

  return withBreaks
    .replace(/<[^>]*>?/gm, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .toLowerCase();
}

function isTopMessageAuthoredBySubject(
  rawHtml: string,
  subjectTokens: string[],
): boolean {
  const structured = toStructuredPlainTextFromHtml(rawHtml);
  const lines = structured
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);

  if (lines.length === 0) return false;

  const dateRe = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i;
  const timeRe = /\b\d{1,2}:\d{2}\s*(am|pm)\b/i;

  return lines.some((line) => {
    const hasHeaderShape = dateRe.test(line) || timeRe.test(line);
    if (!hasHeaderShape) return false;

    return subjectTokens.some((token) => {
      const tokenRe = new RegExp(
        `(^|[^a-z0-9])${escapeRegExp(token)}($|[^a-z0-9])`,
        "i",
      );
      return tokenRe.test(line);
    });
  });
}

function hasSubjectHeaderPattern(
  text: string,
  subjectFullName: string,
): boolean {
  const normalizedSubject = subjectFullName.trim().replace(/\s+/g, " ");
  if (!normalizedSubject) return false;

  const subjectRe = escapeRegExp(normalizedSubject.toLowerCase());

  // Matches: "Subject Name <subject@email.com> 3/12/2025 10:06 PM"
  const headerPattern = new RegExp(
    `\\b${subjectRe}\\b\\s*<[^>\\n]{1,120}@[^>\\n]{1,120}>\\s+\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}\\s+\\d{1,2}:\\d{2}(?:\\s*(?:am|pm))?\\b`,
    "i",
  );

  return headerPattern.test(text);
}

// A sender header line looks like:
//   "Name <email@domain> 3/12/2025 10:06 PM"  or  "Name 3/12/2025 10:06 PM"
// The FIRST such line in the export identifies the message's own author.
function findSenderHeaderLines(structuredText: string): string[] {
  const emailBracketRe = /<[^>\n]{1,160}@[^>\n]{1,160}>/i;
  const dateRe = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/;
  const timeRe = /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i;

  return structuredText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const looksLikeHeader =
        emailBracketRe.test(line) || (dateRe.test(line) && timeRe.test(line));
      return looksLikeHeader;
    });
}

// Returns true when the message's own sender (the first sender header line)
// is the data subject. This is the authoritative "subject is the sender" check.
function isFirstSenderSubject(
  structuredText: string,
  subjectTokens: string[],
): boolean {
  const headerLines = findSenderHeaderLines(structuredText);
  if (headerLines.length === 0) return false;

  const topSenderLine = headerLines[0];

  return subjectTokens.some((token) => {
    const tokenRe = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(token)}($|[^a-z0-9])`,
      "i",
    );
    return tokenRe.test(topSenderLine);
  });
}

// Most robust "subject is the sender" detector for Teams exports.
// The sender name always appears immediately BEFORE the first message's
// timestamp (e.g. "Taylor Burgess <tburgess@...> 3/12/2025 10:06 PM").
// Teams frequently splits name/email/timestamp across separate elements, so we
// operate on the flattened text and inspect the window right before the first
// timestamp instead of relying on a single line containing everything.
function isSenderOfFirstMessageSubject(
  flattenedPlainText: string,
  subjectTokens: string[],
): boolean {
  const dateRe = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/;
  const timeRe = /\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i;

  const dateMatch = flattenedPlainText.match(dateRe);
  const timeMatch = flattenedPlainText.match(timeRe);

  let firstTimestampIndex = -1;
  if (typeof dateMatch?.index === "number") {
    firstTimestampIndex = dateMatch.index;
  }
  if (typeof timeMatch?.index === "number") {
    firstTimestampIndex =
      firstTimestampIndex === -1
        ? timeMatch.index
        : Math.min(firstTimestampIndex, timeMatch.index);
  }

  if (firstTimestampIndex === -1) return false;

  // The sender name sits in the text just before the first timestamp.
  const senderWindow = flattenedPlainText
    .slice(0, firstTimestampIndex)
    .slice(-160);

  return subjectTokens.some((token) => {
    const tokenRe = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(token)}($|[^a-z0-9])`,
      "i",
    );
    return tokenRe.test(senderWindow);
  });
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
  const criteria = [subjectCriteria.name, subjectEmail, ...aliases]
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const subjectNameTokens = buildSubjectNameTokens(
    subjectCriteria.name,
    aliases,
  );

  // Shared privileged/confidential keyword filter (see src/lib/exclusions.ts)
  // so the Files pipeline stays in lockstep with the PST pipeline.
  const exclusionsRegex = PRIVILEGED_KEYWORDS_RE;
  const bypassFilters = params.clientMode === true;
  const renderingCriteria = bypassFilters ? [] : criteria;

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

      // --- CRYPTOGRAPHIC DEDUPLICATION CHECK ---
      const fileHash = await withTimeout(
        hashFileSha256(filePath),
        `${file} hash`,
        120_000,
      );
      if (processedHashes.has(fileHash)) {
        console.log(
          `[Standalone Filter] Discarded Duplicate ${file} (Hash: ${fileHash.substring(0, 8)})`,
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
        );
        if (outcome.passwordProtected) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Password-protected/encrypted file.`,
          );
          if (!bypassFilters) {
            skippedCount++;
            continue;
          }
        }
        success = outcome.success;
        semanticContentKey = outcome.contentKey;
        if (success) producedPath = pdfOutputPath;
      }

      // --- HANDLER 2: Excel Spreadsheets ---
      else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
        const outcome = await convertOfficeInWorker(
          "excel",
          filePath,
          pdfOutputPath,
          renderingCriteria,
          seqName,
          bypassFilters,
        );
        if (outcome.passwordProtected) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Password-protected/encrypted file.`,
          );
          if (!bypassFilters) {
            skippedCount++;
            continue;
          }
        }
        success = outcome.success;
        semanticContentKey = outcome.contentKey;
        if (success) producedPath = pdfOutputPath;
      }

      // --- HANDLER 3: Teams Chats (HTML) ---
      else if (ext === ".html" || ext === ".htm") {
        if (!buffer) {
          skippedCount++;
          continue;
        }
        const rawHtml = buffer.toString("utf-8");
        const rawPlainText = toPlainTextFromHtml(rawHtml);
        const plainText = stripEmailSignature(rawPlainText);
        const structuredText = toStructuredPlainTextFromHtml(rawHtml);
        const hasExplicitSubjectHeader = hasSubjectHeaderPattern(
          structuredText,
          subjectCriteria.name,
        );
        const firstSenderIsSubject = isFirstSenderSubject(
          structuredText,
          subjectNameTokens,
        );
        const senderOfFirstMessageIsSubject = isSenderOfFirstMessageSubject(
          plainText,
          subjectNameTokens,
        );
        const topMessageFromSubject = isTopMessageAuthoredBySubject(
          rawHtml,
          subjectNameTokens,
        );
        const plainTextWithoutHeaders = stripLikelyHeaderMentions(
          plainText,
          subjectNameTokens,
        );
        const containsSubjectNameInBody = textContainsAnyToken(
          plainTextWithoutHeaders,
          subjectNameTokens,
        );
        const replyToSubject = isDirectReplyToSubject(
          plainText,
          subjectNameTokens,
        );
        const fromSubject =
          firstSenderIsSubject ||
          senderOfFirstMessageIsSubject ||
          topMessageFromSubject ||
          isAuthoredBySubject(plainText, subjectNameTokens);
        // Client-facing mail frequently includes a generic confidentiality
        // footer. A message sent directly to the data subject is still
        // responsive, matching the PST pipeline's direct-recipient rule.
        const sentToSubjectEmail =
          subjectEmail.length > 0 &&
          new RegExp(
            `\\b(?:to|cc|bcc)\\s*:[^\\n]*${subjectEmail.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`,
            "i",
          ).test(rawPlainText);

        if (
          !bypassFilters &&
          exclusionsRegex.test(plainText) &&
          !sentToSubjectEmail
        ) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Contains excluded keyword.`,
          );
        } else if (!bypassFilters && hasExplicitSubjectHeader) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Matches subject header pattern (Name <email> date time).`,
          );
        } else if (!bypassFilters && fromSubject) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Top message is authored by subject.`,
          );
        } else if (
          !bypassFilters &&
          !containsSubjectNameInBody &&
          !replyToSubject
        ) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Missing subject name in body and no direct reply signal.`,
          );
        } else {
          // Content-level dedup for Teams messages. Byte-identical files are
          // already caught by the SHA256 file hash, but re-exports of the same
          // message usually differ only in markup/whitespace/ids.
          if (isDuplicateContent(plainText, processedHashes)) {
            console.log(
              `[Standalone Filter] Discarded Duplicate HTML ${file} (Content Match).`,
            );
            duplicatesCount++;
            skippedCount++;
            continue;
          }

          try {
            await withTimeout(
              renderHtmlToPdfWeasyPrint(
                normalizeHtmlForPdf(rawHtml),
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
        const hasExplicitSubjectHeader = hasSubjectHeaderPattern(
          rawText,
          subjectCriteria.name,
        );

        const fromSubject = isAuthoredBySubject(rawText, subjectNameTokens);
        const replyToSubject = isDirectReplyToSubject(
          rawText,
          subjectNameTokens,
        );
        const containsSubjectName = textContainsAnyToken(
          rawText,
          subjectNameTokens,
        );

        // Exception: if the email was sent directly TO the subject's personal
        // email address, include it even when it contains a privileged keyword.
        const sentToSubjectEmail =
          subjectEmail.length > 0 &&
          new RegExp(
            `\\bto\\s*:[^\\n]*${subjectEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
            "i",
          ).test(rawText);

        if (
          !bypassFilters &&
          exclusionsRegex.test(rawText) &&
          !sentToSubjectEmail
        ) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Contains excluded keyword.`,
          );
        } else if (!bypassFilters && hasExplicitSubjectHeader) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Matches subject header pattern (Name <email> date time).`,
          );
        } else if (!bypassFilters && fromSubject) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Message appears authored by subject.`,
          );
        } else if (!bypassFilters && !containsSubjectName && !replyToSubject) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Missing subject-name signal.`,
          );
        } else {
          const pdfOutput = path.join(targetDir, `${seqName}.pdf`);

          if (ext === ".eml") {
            let parsed: Awaited<ReturnType<typeof simpleParser>> | null = null;
            try {
              parsed = await withTimeout(simpleParser(buffer), file);
            } catch {
              parsed = null;
            }

            // Dedup on a clean key built from the envelope + body text so that
            // re-exports of the same email collapse even if raw bytes differ.
            const dedupSource = parsed
              ? `${parsed.subject || ""} ${parsed.from?.text || ""} ${parsed.text || parsed.html || ""}`
              : rawText;
            if (isDuplicateContent(dedupSource, processedHashes)) {
              console.log(
                `[Standalone Filter] Discarded Duplicate EML ${file} (Content Match).`,
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
              console.log(
                `[Standalone Filter] Discarded Duplicate MSG ${file} (Content Match).`,
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
        const normalizedText = rawText.toLowerCase();
        if (
          !bypassFilters &&
          !criteria.some((criterion) => normalizedText.includes(criterion))
        ) {
          console.log(
            `[Standalone Filter] Discarded TXT ${file}: Data subject not mentioned.`,
          );
        } else if (isDuplicateContent(normalizedText, processedHashes)) {
          console.log(
            `[Standalone Filter] Discarded Duplicate TXT ${file} (Content Match).`,
          );
          duplicatesCount++;
          skippedCount++;
          continue;
        } else {
          await withTimeout(
            renderHtmlToPdfWeasyPrint(
              buildTextDocumentHtml(rawText, seqName),
              pdfOutputPath,
              file,
            ),
            file,
          );
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

          if (!bypassFilters && exclusionsRegex.test(rawText)) {
            console.log(
              `[Standalone Filter] Discarded PDF ${file}: Contains excluded keyword.`,
            );
          } else if (
            !bypassFilters &&
            !criteria.some((c) => rawText.includes(c))
          ) {
            console.log(
              `[Standalone Filter] Discarded PDF ${file}: Data subject not mentioned.`,
            );
          } else {
            // Additional semantic hash check for content-level duplicate PDFs.
            const textHash = crypto
              .createHash("sha256")
              .update(rawText)
              .digest("hex");
            if (processedHashes.has(textHash)) {
              console.log(
                `[Standalone Filter] Discarded Duplicate PDF ${file} (Content Match).`,
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
            console.log(
              `[Standalone Filter] Discarded PDF ${file}: Password-protected/encrypted file.`,
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

      // Client images and formats the renderer cannot handle are still
      // deliverables: deduplication is the only client-case exclusion.
      else {
        if (!bypassFilters) {
          console.log(
            `[Standalone Engine] Skipping unsupported format: ${file}`,
          );
          continue;
        }
        const destination = path.join(
          deliverablesDirDocuments,
          `Document ${fileHash.slice(0, 16)}${ext}`,
        );
        await fs.promises.copyFile(filePath, destination);
        success = true;
        producedPath = destination;
      }

      // A client case must still deliver a unique source that cannot be
      // rendered (for example an encrypted Office file or malformed message).
      // Keep it in its natural output category with a collision-safe name.
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
          console.warn(
            `[Standalone Filter] Discarded ${file}: produced a 0-byte/empty output.`,
          );
        }
      }

      // Office containers can differ by metadata, revision history, or a
      // workbook id while yielding the exact same visible document. Dedup on
      // the normalized workbook content as well as the source bytes.
      if (success && semanticContentKey) {
        if (processedHashes.has(semanticContentKey)) {
          fs.rmSync(producedPath || pdfOutputPath, { force: true });
          console.log(
            `[Standalone Filter] Discarded Duplicate ${file} (matching Office content).`,
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
