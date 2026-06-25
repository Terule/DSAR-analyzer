import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ParsedMail, simpleParser } from "mailparser";
import mammoth from "mammoth";
import puppeteer, { type Browser, type Page } from "puppeteer";
import * as xlsx from "xlsx";
import { db } from "./db";

type PdfRenderOptions = Parameters<Page["pdf"]>[0];

const PAGE_RECYCLE_THRESHOLD = 20;

function getAddressText(addr: ParsedMail["from"] | ParsedMail["to"]): string {
  if (!addr) return "Unknown";
  if (Array.isArray(addr)) {
    const text = addr.map((a) => a.text).join(", ");
    return text.trim() || "Unknown";
  }
  return addr.text?.trim() || "Unknown";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hardenPdfPage(page: Page) {
  // Enabled JS for CSS rendering stability.
  // Removed aggressive request interception so Puppeteer is allowed to
  // download external images (like signatures/logos) naturally.
  await page.setJavaScriptEnabled(true);
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
}

async function createPdfPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await hardenPdfPage(page);
  return page;
}

async function renderHtmlToPdf(
  page: Page,
  htmlContent: string,
  pdfOptions: PdfRenderOptions,
  label: string,
) {
  await withTimeout(
    page.setContent(htmlContent, {
      waitUntil: "domcontentloaded", // Gives external images/fonts time to load
      timeout: 25_000,
    }),
    35_000,
    `${label} setContent`,
  );

  await withTimeout(
    page.pdf({
      ...pdfOptions,
      timeout: pdfOptions?.timeout ?? 45_000,
    }),
    60_000,
    `${label} page.pdf`,
  );
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });

  try {
    const pdfData = await withTimeout(
      parser.getText(),
      30_000,
      "extractPdfText",
    );
    return pdfData.text || "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function generateEmailHtml(
  parsedEmail: ParsedMail,
  from: string,
  to: string,
  docTitle: string,
): string {
  const subject = parsedEmail.subject || "(No Subject)";
  const date = parsedEmail.date
    ? new Date(parsedEmail.date).toLocaleString()
    : "Unknown Date";

  const headerHtml = `
    <div style="font-family: Arial, sans-serif; border-bottom: 2px solid #ddd; padding-bottom: 10px; margin-bottom: 20px; background: #f9f9f9; padding: 15px;">
      <div style="margin-bottom: 5px; font-size: 14px;"><b>From:</b> ${from}</div>
      <div style="margin-bottom: 5px; font-size: 14px;"><b>Sent:</b> ${date}</div>
      <div style="margin-bottom: 5px; font-size: 14px;"><b>To:</b> ${to}</div>
      <div style="font-size: 16px; margin-top: 10px; border-top: 1px solid #eaeaea; padding-top: 10px;"><b>Subject:</b> ${subject}</div>
    </div>
  `;

  // Use raw HTML if present, otherwise safely convert plain text to HTML layout
  const rawHtml =
    (typeof parsedEmail.html === "string" && parsedEmail.html) ||
    parsedEmail.textAsHtml;
  let html: string;

  if (rawHtml) {
    html = rawHtml;
    // Strip CSP so Puppeteer doesn't block local/external resources
    html = html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, "");

    // 🚨 CRITICAL LAYOUT FIX 🚨
    // We inject our header directly into THEIR HTML to preserve their layout/CSS perfectly
    if (html.match(/<body[^>]*>/i)) {
      html = html.replace(/(<body[^>]*>)/i, `$1\n${headerHtml}`);
    } else {
      html = `${headerHtml}\n${html}`;
    }
  } else {
    // Pure plain text fallback
    const plainText = parsedEmail.text || "(No body content)";
    html = `<!DOCTYPE html><html><head><title>${docTitle}</title></head><body style="font-family: sans-serif; padding: 20px;">${headerHtml}<pre style="white-space: pre-wrap; font-family: sans-serif;">${plainText}</pre></body></html>`;
  }

  // Handle embedded base64 CID images safely
  if (parsedEmail.attachments && parsedEmail.attachments.length > 0) {
    parsedEmail.attachments.forEach((att) => {
      const ext = path.extname(att.filename || "").toLowerCase();
      const isImage =
        att.contentType?.toLowerCase().startsWith("image/") ||
        [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg"].includes(ext);

      if (isImage && att.content) {
        const base64 = att.content.toString("base64");
        const mimeType = att.contentType || "image/jpeg";
        const dataUri = `data:${mimeType};base64,${base64}`;

        const cid = (
          att.contentId ||
          (att as { cid?: string }).cid ||
          ""
        ).replace(/[<>]/g, "");

        if (cid) {
          // Robust exact CID replacement
          const cidRegex = new RegExp(
            `cid:${cid.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`,
            "gi",
          );
          html = html.replace(cidRegex, dataUri);
          // Catch CSS background images
          html = html.replace(
            new RegExp(
              `url\\(['"]?cid:${cid.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}['"]?\\)`,
              "gi",
            ),
            `url(${dataUri})`,
          );
        }

        if (att.filename) {
          // Robust filename fallback replacement
          const nameRegex = new RegExp(
            `src=["'][^"']*${att.filename.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}[^"']*["']`,
            "gi",
          );
          html = html.replace(nameRegex, `src="${dataUri}"`);
        }
      }
    });
  }

  return html;
}

export async function processDocxToPdf(
  buffer: Buffer,
  outputPath: string,
  criteria: string[],
  page: Page,
  docTitle: string,
  processedHashes?: Set<string>,
): Promise<boolean> {
  try {
    const textExtraction = await mammoth.extractRawText({ buffer });
    const rawText = (textExtraction.value || "").toLowerCase();

    const exclusions = ["confidential", "privileged", "cro"];
    if (exclusions.some((ex) => rawText.includes(ex))) {
      return false;
    }

    const mentionsSubject =
      criteria.length === 0 ||
      criteria.some((c) => rawText.includes(c.toLowerCase()));
    if (!mentionsSubject) {
      return false;
    }

    if (processedHashes) {
      const contentHash = crypto
        .createHash("sha256")
        .update(rawText)
        .digest("hex");
      if (processedHashes.has(contentHash)) return false;
      processedHashes.add(contentHash);
    }

    const result = await mammoth.convertToHtml({ buffer });
    const htmlContent = `
      <html>
      <head>
        <title>${docTitle}</title>
        <style>body { font-family: sans-serif; line-height: 1.6; padding: 20px; }</style>
      </head>
      <body>${result.value || "<em>(Empty Document)</em>"}</body>
      </html>
    `;

    await renderHtmlToPdf(
      page,
      htmlContent,
      {
        path: outputPath,
        format: "A4",
        margin: { top: "20mm", bottom: "20mm", left: "20mm", right: "20mm" },
        timeout: 45_000,
      },
      docTitle,
    );
    return true;
  } catch (_err) {
    return false;
  }
}

export async function processExcelToPdf(
  buffer: Buffer,
  outputPath: string,
  criteria: string[],
  page: Page,
  docTitle: string,
  processedHashes?: Set<string>,
): Promise<boolean> {
  try {
    const wb = xlsx.read(buffer, { type: "buffer" });

    let htmlContent = `
      <html><head>
        <title>${docTitle}</title>
        <style>
        @page { size: A4 landscape; margin: 10mm; }
        body { font-family: 'Helvetica', sans-serif; font-size: 8pt; padding: 5px; }
        table { border-collapse: collapse; width: 100%; table-layout: fixed; margin-bottom: 20px; }
        th, td { border: 0.5px solid #ccc; padding: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        th { background-color: #f8f8f8; font-weight: bold; }
        .highlight { background-color: #fff3cd !important; }
      </style></head><body>
      <h1>Redacted Data Subject Spreadsheet</h1>
    `;

    let foundMatches = false;
    let totalRowsRendered = 0;
    const MAX_ROWS = 1500;
    const MAX_COLS = 30;

    for (const sheetName of wb.SheetNames) {
      if (totalRowsRendered >= MAX_ROWS) break;

      const sheet = wb.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(sheet, {
        header: 1,
      }) as string[][];
      if (jsonData.length === 0) continue;

      const headers = jsonData[0] || [];
      const matchedRows = jsonData.slice(1).filter((row) => {
        return row.some((cell) => {
          if (cell == null) return false;
          const cellStr = String(cell).toLowerCase();
          return criteria.some((c) => cellStr.includes(c));
        });
      });

      if (matchedRows.length > 0) {
        foundMatches = true;
        htmlContent += `<h2>Sheet: ${sheetName} (Filtered)</h2><table><thead><tr>`;

        const colCount = Math.min(headers.length, MAX_COLS);
        for (let i = 0; i < colCount; i++) {
          htmlContent += `<th>${String(headers[i] || "")
            .substring(0, 100)
            .replace(/</g, "&lt;")}</th>`;
        }
        htmlContent += `</tr></thead><tbody>`;

        for (const row of matchedRows) {
          if (totalRowsRendered >= MAX_ROWS) break;
          htmlContent += `<tr>`;
          for (let i = 0; i < colCount; i++) {
            const cellVal = String(row[i] || "")
              .substring(0, 500)
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            const isMatch = criteria.some((c) =>
              cellVal.toLowerCase().includes(c),
            );
            htmlContent += `<td class="${isMatch ? "highlight" : ""}">${cellVal}</td>`;
          }
          htmlContent += `</tr>`;
          totalRowsRendered++;
        }
        htmlContent += `</tbody></table>`;
      }
    }

    if (!foundMatches) return false;

    if (processedHashes) {
      const contentHash = crypto
        .createHash("sha256")
        .update(htmlContent)
        .digest("hex");
      if (processedHashes.has(contentHash)) return false;
      processedHashes.add(contentHash);
    }

    htmlContent += `</body></html>`;

    await renderHtmlToPdf(
      page,
      htmlContent,
      {
        path: outputPath,
        format: "A4",
        landscape: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
        timeout: 45_000,
      },
      docTitle,
    );
    return true;
  } catch (_err) {
    return false;
  }
}

export async function processPdfAttachment(
  buffer: Buffer,
  outputPath: string,
  criteria: string[],
  _docTitle: string, // Biome Fix: Prepended with _ to indicate it is intentionally unused but required by signature
  processedHashes?: Set<string>,
): Promise<boolean> {
  try {
    const rawText = (await extractPdfText(buffer)).toLowerCase();

    const exclusions = ["confidential", "privileged", "cro"];
    if (exclusions.some((ex) => rawText.includes(ex))) return false;

    const mentionsSubject =
      criteria.length === 0 ||
      criteria.some((c) => rawText.includes(c.toLowerCase()));
    if (!mentionsSubject) return false;

    if (processedHashes) {
      const contentHash = crypto
        .createHash("sha256")
        .update(rawText)
        .digest("hex");
      if (processedHashes.has(contentHash)) return false;
      processedHashes.add(contentHash);
    }

    fs.writeFileSync(outputPath, buffer);
    return true;
  } catch (_err) {
    fs.writeFileSync(outputPath, buffer);
    return true;
  }
}

// 🔥 Helper to launch a fresh, healthy browser instance
async function launchHealthyBrowser(): Promise<Browser> {
  return await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--js-flags=--max-old-space-size=4096", // Increase JS heap to 4GB
    ],
  });
}

export async function convertToPdfBatch(
  fileId: string,
  outputBaseDir: string = process.env.EXTRACTED_PATH ||
    "/Users/rgomes/Projects/extracted_emails",
) {
  try {
    db.exec(
      "ALTER TABLE processed_files ADD COLUMN pdf_status TEXT DEFAULT 'pending'",
    );
  } catch (_e) {}

  const row = db
    .prepare(
      "SELECT filepath, subject_name, subject_email, subject_aliases FROM processed_files WHERE id = ?",
    )
    .get(fileId) as
    | {
        filepath: string;
        subject_name?: string;
        subject_email?: string;
        subject_aliases?: string;
      }
    | undefined;

  if (!row) throw new Error(`File ID not found: ${fileId}`);

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  let relativeSystemPath = path.relative(stagingPath, row.filepath);
  if (
    relativeSystemPath.startsWith("..") ||
    path.isAbsolute(relativeSystemPath)
  ) {
    relativeSystemPath = fileId;
  }

  let cleanRelativePath = path.dirname(relativeSystemPath);
  if (cleanRelativePath === "." || cleanRelativePath === "") {
    cleanRelativePath = path.parse(relativeSystemPath).name;
  }

  const allFiles = db
    .prepare("SELECT id, filepath FROM processed_files")
    .all() as { id: string; filepath: string }[];
  const unifiedFileIds: string[] = [];

  for (const f of allFiles) {
    let fRel = path.relative(stagingPath, f.filepath);
    if (fRel.startsWith("..") || path.isAbsolute(fRel)) fRel = f.id;
    let fClean = path.dirname(fRel);
    if (fClean === "." || fClean === "") fClean = path.parse(fRel).name;

    if (fClean === cleanRelativePath) {
      unifiedFileIds.push(f.id);
    }
  }

  if (unifiedFileIds.length === 0) unifiedFileIds.push(fileId);

  const placeholders = unifiedFileIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE processed_files SET pdf_status = 'processing' WHERE id IN (${placeholders})`,
  ).run(...unifiedFileIds);

  const filterCriteria: string[] = [];
  if (row.subject_name) filterCriteria.push(row.subject_name.toLowerCase());
  if (row.subject_email) filterCriteria.push(row.subject_email.toLowerCase());
  if (row.subject_aliases) {
    row.subject_aliases.split(",").forEach((a) => {
      const alias = a.trim().toLowerCase();
      if (alias) filterCriteria.push(alias);
    });
  }

  const targetFolder = path.join(outputBaseDir, cleanRelativePath);
  const exportDir = path.join(targetFolder, "export");
  const deliverablesDir = path.join(targetFolder, "Deliverables");
  const logsDir = path.join(targetFolder, "logs"); // Dedicated log folder

  if (!fs.existsSync(exportDir)) {
    console.error(
      `[PDF Engine] ERROR: Export directory missing at ${exportDir}`,
    );
    db.prepare(
      `UPDATE processed_files SET pdf_status = 'failed' WHERE id IN (${placeholders})`,
    ).run(...unifiedFileIds);
    return;
  }

  if (!fs.existsSync(deliverablesDir))
    fs.mkdirSync(deliverablesDir, { recursive: true });
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await launchHealthyBrowser();
    page = await createPdfPage(browser);

    const initialEmlFiles = fs
      .readdirSync(exportDir)
      .filter((f) => f.toLowerCase().endsWith(".eml"))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      );

    // Queue system to allow for retries
    const emlFilesToProcess = [...initialEmlFiles];
    const failedOnce = new Set<string>();

    let documentsProcessed = 0;
    let generatedPdfs = 0;
    let skippedPdfs = 0;
    let renderFailures = 0;
    const processedAttachmentHashes = new Set<string>();

    while (emlFilesToProcess.length > 0) {
      const filename = emlFilesToProcess.shift();
      if (!filename) break; // Biome Fix: Avoid non-null assertions

      const emlPath = path.join(exportDir, filename);
      const baseName = filename.replace(/\.eml$/i, "");
      const emailPdfPath = path.join(deliverablesDir, `${baseName}.pdf`);

      try {
        // --- 1. Memory Recycling Check ---
        if (documentsProcessed >= PAGE_RECYCLE_THRESHOLD) {
          console.log(`[Memory Manager] Recycling page to prevent leaks...`);
          if (page) await page.close().catch(() => {});
          page = await createPdfPage(browser);
          documentsProcessed = 0;
        }

        const rawEml = fs.readFileSync(emlPath);
        const parsed = await withTimeout(
          simpleParser(rawEml),
          60_000,
          `simpleParser ${baseName}`,
        );

        const fromText = getAddressText(parsed.from);
        const toText = getAddressText(parsed.to);

        if (fromText === "Unknown" || toText === "Unknown") continue;

        // --- 2. Render Email Body ---
        if (!fs.existsSync(emailPdfPath)) {
          const htmlContent = generateEmailHtml(
            parsed,
            fromText,
            toText,
            baseName,
          );
          console.log(`[PDF Engine] Rendering ${baseName}.pdf`);

          await renderHtmlToPdf(
            page,
            htmlContent,
            {
              path: emailPdfPath,
              format: "A4",
              margin: {
                top: "20mm",
                bottom: "20mm",
                left: "20mm",
                right: "20mm",
              },
              printBackground: true,
              timeout: 45_000,
            },
            `${baseName}.pdf`,
          );

          generatedPdfs++;
          documentsProcessed++;

          // Clear visual memory state cleanly
          await page
            .evaluate(() => {
              window.location.href = "about:blank";
            })
            .catch(() => {});
        } else {
          skippedPdfs++;
        }

        // --- 3. Process Attachments ---
        if (parsed.attachments && parsed.attachments.length > 0) {
          let attachmentCounter = 1;
          const allowedExtensions = [
            ".zip",
            ".pdf",
            ".docx",
            ".doc",
            ".xlsx",
            ".xls",
            ".csv",
          ];

          for (const att of parsed.attachments) {
            const ext = path.extname(att.filename || "").toLowerCase();
            if (!allowedExtensions.includes(ext)) continue;

            const fileHash = crypto
              .createHash("sha256")
              .update(att.content)
              .digest("hex");
            if (processedAttachmentHashes.has(fileHash)) continue;
            processedAttachmentHashes.add(fileHash);

            const attSeqName = `${baseName} Attachment ${String(attachmentCounter).padStart(3, "0")}`;
            attachmentCounter++;

            if (ext === ".docx") {
              const docxPdfPath = path.join(
                deliverablesDir,
                `${attSeqName}.pdf`,
              );
              if (!fs.existsSync(docxPdfPath)) {
                const success = await processDocxToPdf(
                  att.content,
                  docxPdfPath,
                  filterCriteria,
                  page,
                  attSeqName,
                  processedAttachmentHashes,
                );
                if (!success && fs.existsSync(docxPdfPath))
                  fs.unlinkSync(docxPdfPath);
              }
            } else if (ext === ".doc" || ext === ".zip") {
              const rawPath = path.join(deliverablesDir, `${attSeqName}${ext}`);
              if (!fs.existsSync(rawPath))
                fs.writeFileSync(rawPath, att.content);
            } else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
              const excelPdfPath = path.join(
                deliverablesDir,
                `${attSeqName}.pdf`,
              );
              if (!fs.existsSync(excelPdfPath)) {
                const success = await processExcelToPdf(
                  att.content,
                  excelPdfPath,
                  filterCriteria,
                  page,
                  attSeqName,
                  processedAttachmentHashes,
                );
                if (!success && fs.existsSync(excelPdfPath))
                  fs.unlinkSync(excelPdfPath);
              }
            } else if (ext === ".pdf") {
              const pdfPath = path.join(deliverablesDir, `${attSeqName}${ext}`);
              if (!fs.existsSync(pdfPath)) {
                await processPdfAttachment(
                  att.content,
                  pdfPath,
                  filterCriteria,
                  attSeqName,
                  processedAttachmentHashes,
                );
              }
            }
          }
        }
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        const errMsg = errorObj.message.toLowerCase();

        console.error(`[PDF Engine] Error on ${filename}:`, errMsg);

        if (!failedOnce.has(filename)) {
          // Retry the email ONCE by pushing it to the end of the line
          console.log(
            `[PDF Engine] 🔄 Queuing ${filename} for a retry attempt...`,
          );
          failedOnce.add(filename);
          emlFilesToProcess.push(filename);

          // Reboot the browser to clear any crashed instances
          try {
            if (page) await page.close();
          } catch (_e) {}
          try {
            if (browser) await browser.close();
          } catch (_e) {}

          browser = await launchHealthyBrowser();
          page = await createPdfPage(browser);
          documentsProcessed = 0;
        } else {
          // File failed TWICE, mark it as a definitive failure and move on.
          renderFailures++;
          console.log(
            `[PDF Engine] ❌ ${filename} failed twice. Logging error.`,
          );

          // Leave an error tombstone in the separate Logs directory
          const errorTombstone = path.join(
            logsDir,
            `${baseName}_RENDER_FAILED.txt`,
          );
          if (!fs.existsSync(errorTombstone)) {
            fs.writeFileSync(
              errorTombstone,
              `Failed to render PDF.\nError: ${errorObj.message}\nPlease review the original EML file.`,
            );
          }

          // Restart browser if the failure was catastrophic
          if (
            errMsg.includes("target closed") ||
            errMsg.includes("connection closed") ||
            errMsg.includes("session closed")
          ) {
            try {
              if (page) await page.close();
            } catch (_e) {}
            try {
              if (browser) await browser.close();
            } catch (_e) {}
            browser = await launchHealthyBrowser();
            page = await createPdfPage(browser);
            documentsProcessed = 0;
          }
        }
      }
    }

    console.log(
      `[PDF Engine] Batch finished! Generated ${generatedPdfs} new PDFs. Skipped ${skippedPdfs} existing PDFs. Failures: ${renderFailures}.`,
    );

    // Copy any loose raw files from export to deliverables safely
    const remainingFiles = fs.readdirSync(exportDir);
    for (const file of remainingFiles) {
      const ext = path.extname(file).toLowerCase();

      // Strict routing: TXT logs to logsDir, valid attachments to deliverables
      if (ext === ".txt") {
        const src = path.join(exportDir, file);
        const dst = path.join(logsDir, file);
        try {
          fs.copyFileSync(src, dst);
          fs.unlinkSync(src);
        } catch (_e) {}
      } else if (ext !== ".eml") {
        const src = path.join(exportDir, file);
        const dst = path.join(deliverablesDir, file);
        if (!fs.existsSync(dst)) {
          try {
            fs.copyFileSync(src, dst);
          } catch (_e) {}
        }
      }
    }

    db.prepare(
      `UPDATE processed_files SET pdf_status = 'completed' WHERE id IN (${placeholders})`,
    ).run(...unifiedFileIds);
  } catch (error) {
    console.error(`Fatal error in PDF conversion engine for ${fileId}:`, error);
    db.prepare(
      `UPDATE processed_files SET pdf_status = 'failed' WHERE id IN (${placeholders})`,
    ).run(...unifiedFileIds);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
