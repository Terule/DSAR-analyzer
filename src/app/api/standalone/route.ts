import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleParser } from "mailparser";
import { NextResponse } from "next/server";
import {
  extractPdfText,
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

      const ext = path.extname(file).toLowerCase();
      const buffer = fs.readFileSync(filePath);

      // --- CRYPTOGRAPHIC DEDUPLICATION CHECK ---
      const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
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
        success = await processDocxToPdf(
          buffer,
          pdfOutputPath,
          criteria,
          seqName,
          processedHashes,
        );
      }

      // --- HANDLER 2: Excel Spreadsheets ---
      else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
        success = await processExcelToPdf(
          buffer,
          pdfOutputPath,
          criteria,
          seqName,
          processedHashes,
        );
      }

      // --- HANDLER 3: Teams Chats (HTML) ---
      else if (ext === ".html" || ext === ".htm") {
        const rawHtml = buffer.toString("utf-8");
        const rawText = rawHtml.replace(/<[^>]*>?/gm, " ").toLowerCase();

        if (exclusionsRegex.test(rawText)) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Contains excluded keyword.`,
          );
        } else if (!criteria.some((c) => rawText.includes(c))) {
          console.log(
            `[Standalone Filter] Discarded HTML ${file}: Data subject not mentioned.`,
          );
        } else {
          try {
            await renderHtmlToPdfWeasyPrint(rawHtml, pdfOutputPath, seqName);
            success = true;
          } catch (_e) {
            console.warn(
              `[Standalone Filter] Failed to render HTML to PDF: ${file}. Saving raw HTML instead as fallback.`,
            );

            // 🔥 The Fallback Fix: Save the raw HTML directly if WeasyPrint crashes!
            const fallbackPath = path.join(targetDir, `${seqName}${ext}`);
            fs.copyFileSync(filePath, fallbackPath);
            success = true;
          }
        }
      }

      // --- HANDLER 4: Outlook MSG & EML Files ---
      else if (ext === ".msg" || ext === ".eml") {
        // 🔥 The UTF-16LE Fix: Read both UTF-8 (for EML) and UTF-16 (for MSG blobs)
        // simultaneously, and strip out null bytes to ensure pure text matching!
        const rawUtf8 = buffer.toString("utf-8").toLowerCase();
        const rawUtf16 = buffer.toString("utf16le").toLowerCase();
        const rawText = `${rawUtf8} ${rawUtf16}`.replace(/\0/g, "");

        if (exclusionsRegex.test(rawText)) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Contains excluded keyword.`,
          );
        } else if (!criteria.some((c) => rawText.includes(c))) {
          console.log(
            `[Standalone Filter] Discarded ${ext.toUpperCase()} ${file}: Data subject not mentioned.`,
          );
        } else {
          const pdfOutput = path.join(targetDir, `${seqName}.pdf`);

          if (ext === ".eml") {
            try {
              const parsed = await simpleParser(buffer);
              const emailBody =
                parsed.html || parsed.textAsHtml || parsed.text || rawText;
              await renderHtmlToPdfWeasyPrint(
                normalizeHtmlForPdf(String(emailBody)),
                pdfOutput,
                seqName,
              );
              success = true;
            } catch (_e) {
              // Fallback for malformed EML payloads.
              await renderHtmlToPdfWeasyPrint(
                buildEmailHtml(rawText, file),
                pdfOutput,
                seqName,
              );
              success = true;
            }
          } else {
            // MSG parsing is inconsistent across archives, so render extracted text safely.
            await renderHtmlToPdfWeasyPrint(
              buildEmailHtml(rawText, file),
              pdfOutput,
              seqName,
            );
            success = true;
          }
        }
      }

      // --- HANDLER 5: Raw PDFs ---
      else if (ext === ".pdf") {
        try {
          const rawText = (await extractPdfText(buffer)).toLowerCase();

          if (exclusionsRegex.test(rawText)) {
            console.log(
              `[Standalone Filter] Discarded PDF ${file}: Contains excluded keyword.`,
            );
          } else if (!criteria.some((c) => rawText.includes(c))) {
            console.log(
              `[Standalone Filter] Discarded PDF ${file}: Data subject not mentioned.`,
            );
          } else {
            // ADD SEMANTIC HASH CHECK HERE
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

            fs.copyFileSync(filePath, pdfOutputPath);
            success = true;
          }
        } catch (_e) {
          console.warn(
            `[Standalone Filter] Failed to parse PDF ${file}. Saving raw file as fallback.`,
          );
          fs.copyFileSync(filePath, pdfOutputPath);
          success = true;
        }
      }

      // --- Unsupported Files ---
      else {
        console.log(`[Standalone Engine] Skipping unsupported format: ${file}`);
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
