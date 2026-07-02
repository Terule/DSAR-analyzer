import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { simpleParser } from "mailparser";
import { NextResponse } from "next/server";
import {
  normalizeHtmlForPdf,
  processDocxToPdf,
  processExcelToPdf,
} from "@/lib/converter";

export const dynamic = "force-dynamic";

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

function isLikelyPasswordProtectedPdf(buffer: Buffer): boolean {
  // Common encrypted PDF marker.
  return buffer.includes(Buffer.from("/Encrypt", "utf-8"));
}

function isLikelyPasswordProtectedOffice(buffer: Buffer): boolean {
  // OOXML encrypted containers usually include this marker.
  return buffer.includes(Buffer.from("EncryptedPackage", "utf-8"));
}

function isPasswordProtectionError(error: unknown): boolean {
  const msg = String(
    error instanceof Error ? error.message : error,
  ).toLowerCase();
  return /(password|passphrase|encrypted|encryption|decrypt|protected)/.test(
    msg,
  );
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

  fs.writeFileSync(htmlPath, htmlContent, "utf-8");

  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "weasyprint",
      ["-q", "-e", "utf-8", htmlPath, outputPath],
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
        resolve();
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

export async function POST(request: Request) {
  try {
    const { caseName, subjectCriteria } = await request.json();

    if (!caseName || !subjectCriteria?.name) {
      return NextResponse.json(
        { success: false, error: "Missing caseName or subjectCriteria.name" },
        { status: 400 },
      );
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

    const exclusions = ["confidential", "privileged", "cro", "cros"];

    // Strict word boundaries prevent "Microsoft" from triggering the "cro" exclusion!
    const exclusionsRegex = new RegExp(`\\b(${exclusions.join("|")})\\b`, "i");

    // 2. Define Paths
    const stagingBase =
      process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
    const standaloneStagingDir = path.join(stagingBase, "standalone", caseName);

    // Output paths flattened cleanly into Messages and Documents
    const outputBaseDir =
      process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";
    const deliverablesDirMessages = path.join(
      outputBaseDir,
      caseName,
      "Messages",
    );
    const deliverablesDirDocuments = path.join(
      outputBaseDir,
      caseName,
      "Documents",
    );

    if (!fs.existsSync(standaloneStagingDir)) {
      return NextResponse.json(
        {
          success: false,
          error: `No standalone directory found at ${standaloneStagingDir}`,
        },
        { status: 404 },
      );
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

    // In-memory set to track hashes for deduplication
    const processedHashes = new Set<string>();

    for (const filePath of allFiles) {
      const file = path.basename(filePath);

      // Skip hidden system files and JSON metadata files
      if (file.startsWith(".") || file.toLowerCase().endsWith(".json"))
        continue;

      try {
        // Yield between files so the API server remains responsive.
        await yieldToEventLoop();

        const ext = path.extname(file).toLowerCase();
        const buffer = await fs.promises.readFile(filePath);

        if (ext === ".pdf" && isLikelyPasswordProtectedPdf(buffer)) {
          console.log(
            `[Standalone Filter] Discarded PDF ${file}: Password-protected/encrypted file.`,
          );
          skippedCount++;
          continue;
        }

        if (
          (ext === ".docx" || ext === ".xlsx") &&
          isLikelyPasswordProtectedOffice(buffer)
        ) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Password-protected/encrypted file.`,
          );
          skippedCount++;
          continue;
        }

        // --- CRYPTOGRAPHIC DEDUPLICATION CHECK ---
        const fileHash = crypto
          .createHash("sha256")
          .update(buffer)
          .digest("hex");
        if (processedHashes.has(fileHash)) {
          console.log(
            `[Standalone Filter] Discarded Duplicate ${file} (Hash: ${fileHash.substring(0, 8)})`,
          );
          duplicatesCount++;
          skippedCount++; // Count as skipped for the UI
          continue;
        }

        let success = false;
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
          success = await withTimeout(
            processDocxToPdf(
              buffer,
              pdfOutputPath,
              criteria,
              seqName,
              processedHashes,
            ),
            file,
          );
        }

        // --- HANDLER 2: Excel Spreadsheets ---
        else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
          success = await withTimeout(
            processExcelToPdf(
              buffer,
              pdfOutputPath,
              criteria,
              seqName,
              processedHashes,
            ),
            file,
          );
        }

        // --- HANDLER 3: Teams Chats (HTML) ---
        else if (ext === ".html" || ext === ".htm") {
          const rawHtml = buffer.toString("utf-8");
          const plainText = toPlainTextFromHtml(rawHtml);
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
            topMessageFromSubject ||
            isAuthoredBySubject(plainText, subjectNameTokens);

          if (exclusionsRegex.test(plainText)) {
            console.log(
              `[Standalone Filter] Discarded HTML ${file}: Contains excluded keyword.`,
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
            } catch (_e) {
              console.warn(
                `[Standalone Filter] Failed to render HTML to PDF: ${file}. Saving raw HTML instead as fallback.`,
              );

              // Preserve the source HTML when rendering fails.
              const fallbackPath = path.join(targetDir, `${seqName}${ext}`);
              await fs.promises.copyFile(filePath, fallbackPath);
              success = true;
            }
          }
        }

        // --- HANDLER 4: Outlook MSG & EML Files ---
        else if (ext === ".msg" || ext === ".eml") {
          // Read both UTF-8 (for EML) and UTF-16 (for MSG blobs), then strip null bytes.
          const rawUtf8 = buffer.toString("utf-8").toLowerCase();
          const rawUtf16 = buffer.toString("utf16le").toLowerCase();
          const rawText = `${rawUtf8} ${rawUtf16}`.replace(/\0/g, " ");

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
              try {
                const parsed = await withTimeout(simpleParser(buffer), file);
                const emailBody =
                  parsed.html || parsed.textAsHtml || parsed.text || rawText;
                await withTimeout(
                  renderHtmlToPdfWeasyPrint(
                    normalizeHtmlForPdf(String(emailBody)),
                    pdfOutput,
                    seqName,
                  ),
                  file,
                );
                success = true;
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
                success = true;
              }
            } else {
              // MSG parsing is inconsistent across archives, so render extracted text safely.
              await withTimeout(
                renderHtmlToPdfWeasyPrint(
                  buildEmailHtml(rawText, file),
                  pdfOutput,
                  seqName,
                ),
                file,
              );
              success = true;
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
          }
        }

        // --- Unsupported Files ---
        else {
          console.log(
            `[Standalone Engine] Skipping unsupported format: ${file}`,
          );
          continue;
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
        console.error(
          `[Standalone Engine] Failed file ${filePath}:`,
          fileError,
        );
        skippedCount++;
      }
    }

    console.log(
      `\n[Standalone Engine] Finished! Processed: ${processedCount} | Dropped: ${skippedCount} (Duplicates: ${duplicatesCount})\n`,
    );

    return NextResponse.json(
      {
        success: true,
        message: `Standalone batch completed. Deduplicated ${duplicatesCount} identical files.`,
        processedCount,
        skippedCount,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("API route /api/standalone encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
