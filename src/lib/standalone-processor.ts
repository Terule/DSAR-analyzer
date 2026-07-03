import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { simpleParser } from "mailparser";
import { normalizeHtmlForPdf } from "./converter";
import { PRIVILEGED_KEYWORDS_RE } from "./exclusions";

export interface StandaloneBatchParams {
  inputDir: string;
  messagesDir: string;
  documentsDir: string;
  subjectCriteria: { name: string; aliases?: string[] };
}

export interface StandaloneBatchResult {
  success: boolean;
  error?: string;
  message?: string;
  processedCount?: number;
  skippedCount?: number;
  duplicatesCount?: number;
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
  timeoutMs = 150_000,
): Promise<OfficeConversionOutcome> {
  const workerPath = path.resolve(process.cwd(), "office-worker.ts");

  return await new Promise<OfficeConversionOutcome>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: { kind, filePath, outputPath, criteria, docTitle },
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
        error?: string;
      }) => {
        if (msg.ok) {
          finish(() =>
            resolve({
              success: Boolean(msg.success),
              passwordProtected: Boolean(msg.passwordProtected),
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
}

export async function runStandaloneBatch(
  params: StandaloneBatchParams,
  onProgress?: (progress: StandaloneBatchProgress) => void,
): Promise<StandaloneBatchResult> {
  const { inputDir, messagesDir, documentsDir, subjectCriteria } = params;

  if (!inputDir || !subjectCriteria?.name) {
    return {
      success: false,
      error: "Missing inputDir or subjectCriteria.name",
    };
  }

  // 1. Build Criteria & Exclusion Arrays (Added trim for safety)
  const aliases = subjectCriteria.aliases || [];
  const criteria = [subjectCriteria.name, ...aliases]
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const subjectNameTokens = buildSubjectNameTokens(
    subjectCriteria.name,
    aliases,
  );

  // Shared privileged/confidential keyword filter (see src/lib/exclusions.ts)
  // so the Files pipeline stays in lockstep with the PST pipeline.
  const exclusionsRegex = PRIVILEGED_KEYWORDS_RE;

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

  // Track counters separately for clean sequential naming
  let messageCounter = 1;
  let documentCounter = 1;

  console.log(`\n=================================================`);
  console.log(`[Standalone Engine] Scanning: ${standaloneStagingDir}`);
  console.log(
    `[Standalone Engine] Saving to: ${deliverablesDirMessages} and ${deliverablesDirDocuments}`,
  );
  console.log(`=================================================\n`);

  // Retrieve all files recursively
  const allFiles = getAllFiles(standaloneStagingDir);
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
      const inProcessExts = new Set([".html", ".htm", ".eml", ".msg"]);
      const buffer = inProcessExts.has(ext)
        ? await withTimeout(
            fs.promises.readFile(filePath),
            `${file} read`,
            60_000,
          )
        : undefined;

      let success = false;
      let producedPath: string | null = null;
      let targetDir = deliverablesDirDocuments;
      let isMessage = false;

      // Route files to appropriate folders
      if (
        ext === ".html" ||
        ext === ".htm" ||
        ext === ".eml" ||
        ext === ".msg"
      ) {
        targetDir = deliverablesDirMessages;
        isMessage = true;
      }

      // Generate clean sequential names
      const padLen = 4;
      const seqName = isMessage
        ? `Message ${String(messageCounter).padStart(padLen, "0")}`
        : `Document ${String(documentCounter).padStart(padLen, "0")}`;

      const pdfOutputPath = path.join(targetDir, `${seqName}.pdf`);

      // --- HANDLER 1: Word Documents ---
      if (ext === ".docx" || ext === ".doc") {
        const outcome = await convertOfficeInWorker(
          "docx",
          filePath,
          pdfOutputPath,
          criteria,
          seqName,
        );
        if (outcome.passwordProtected) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Password-protected/encrypted file.`,
          );
          skippedCount++;
          continue;
        }
        success = outcome.success;
        if (success) producedPath = pdfOutputPath;
      }

      // --- HANDLER 2: Excel Spreadsheets ---
      else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
        const outcome = await convertOfficeInWorker(
          "excel",
          filePath,
          pdfOutputPath,
          criteria,
          seqName,
        );
        if (outcome.passwordProtected) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Password-protected/encrypted file.`,
          );
          skippedCount++;
          continue;
        }
        success = outcome.success;
        if (success) producedPath = pdfOutputPath;
      }

      // --- HANDLER 3: Teams Chats (HTML) ---
      else if (ext === ".html" || ext === ".htm") {
        if (!buffer) {
          skippedCount++;
          continue;
        }
        const rawHtml = buffer.toString("utf-8");
        const plainText = toPlainTextFromHtml(rawHtml);
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

        if (exclusionsRegex.test(plainText)) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Contains excluded keyword.`,
          );
        } else if (hasExplicitSubjectHeader) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Matches subject header pattern (Name <email> date time).`,
          );
        } else if (fromSubject) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Top message is authored by subject.`,
          );
        } else if (!containsSubjectNameInBody && !replyToSubject) {
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
        // Read both UTF-8 (for EML) and UTF-16 (for MSG blobs), then strip null bytes.
        const rawUtf8 = buffer.toString("utf-8").toLowerCase();
        const rawUtf16 = buffer.toString("utf16le").toLowerCase();
        const rawText = `${rawUtf8} ${rawUtf16}`.replace(/\0/g, " ");
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

        if (exclusionsRegex.test(rawText)) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Contains excluded keyword.`,
          );
        } else if (hasExplicitSubjectHeader) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Matches subject header pattern (Name <email> date time).`,
          );
        } else if (fromSubject) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Message appears authored by subject.`,
          );
        } else if (!containsSubjectName && !replyToSubject) {
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
            // MSG parsing is inconsistent across archives, so dedup and render
            // from the extracted raw text.
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
                buildEmailHtml(rawText, file),
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

      // --- HANDLER 5: Raw PDFs ---
      else if (ext === ".pdf") {
        try {
          const rawText = (
            await extractPdfTextInWorker(filePath, file, 45_000)
          ).toLowerCase();

          if (exclusionsRegex.test(rawText)) {
            console.log(
              `[Standalone Filter] Discarded PDF ${file}: Contains excluded keyword.`,
            );
          } else if (!criteria.some((c) => rawText.includes(c))) {
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

      // --- Unsupported Files ---
      else {
        console.log(`[Standalone Engine] Skipping unsupported format: ${file}`);
        continue;
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

      // Tally results and increment counters only on success
      if (success) {
        processedHashes.add(fileHash); // Lock this hash so future duplicates are dropped
        processedCount++;
        if (isMessage) messageCounter++;
        else documentCounter++;
        console.log(`[Standalone Engine] Exported: ${seqName}.pdf`);
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
