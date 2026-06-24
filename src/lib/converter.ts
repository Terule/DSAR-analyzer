import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ParsedMail, simpleParser } from "mailparser";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import puppeteer, { type Page } from "puppeteer";
import * as xlsx from "xlsx";
import { db } from "./db";

// --- HTML Generators ---

function getAddressText(addr: ParsedMail["from"] | ParsedMail["to"]): string {
  if (!addr) return "Unknown";
  if (Array.isArray(addr)) {
    const text = addr.map((a) => a.text).join(", ");
    return text.trim() || "Unknown";
  }
  return addr.text?.trim() || "Unknown";
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

  let bodyContent = parsedEmail.html || "";

  bodyContent = bodyContent.replace(
    /<meta[^>]*Content-Security-Policy[^>]*>/gi,
    "",
  );

  if (!bodyContent && parsedEmail.text) {
    const cleanText = parsedEmail.text.replace(/(\r?\n){3,}/g, "\n\n");
    bodyContent = `<pre style="white-space: pre-wrap; font-family: sans-serif;">${cleanText}</pre>`;
  } else if (!bodyContent) {
    bodyContent = "<em>(No body content)</em>";
  }

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
          const escapeCid = cid.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
          bodyContent = bodyContent.replace(
            new RegExp(`src=["']?cid:${escapeCid}[^"']*["']?`, "gi"),
            `src="${dataUri}"`,
          );
          bodyContent = bodyContent.replace(
            new RegExp(`cid:${escapeCid}`, "gi"),
            dataUri,
          );
        }

        if (att.filename) {
          const safeFilename = att.filename.replace(
            /[-/\\^$*+?.()|[\]{}]/g,
            "\\$&",
          );
          bodyContent = bodyContent.replace(
            new RegExp(`src=["'][^"']*${safeFilename}[^"']*["']`, "gi"),
            `src="${dataUri}"`,
          );
        }
      }
    });
  }

  bodyContent = bodyContent
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/page-break-(before|after)\s*:\s*always;?/gi, "")
    .replace(/<o:p>\s*(?:&nbsp;|\s)*\s*<\/o:p>/gi, "")
    .replace(
      /(<(p|div)[^>]*>\s*(?:&nbsp;|<br\s*\/?>|\s|<o:p><\/o:p>)*<\/(p|div)>\s*){2,}/gi,
      "<br>",
    )
    .replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${docTitle}</title>
      <style>
        body { font-family: sans-serif; line-height: 1.5; color: #333; margin: 0; padding: 20px; }
        .header { border-bottom: 2px solid #eee; padding-bottom: 15px; margin-bottom: 20px; }
        .header-row { margin-bottom: 5px; }
        .label { font-weight: bold; color: #555; margin-right: 5px; }
        .subject { font-size: 1.2em; font-weight: bold; margin-top: 10px; }
        .body-container { overflow-wrap: break-word; }
        
        .body-container div, .body-container table, .body-container td, .body-container tr, .body-container p {
            height: auto !important;
            min-height: 0 !important;
        }

        img { max-width: 100%; height: auto; display: inline-block; }
        blockquote { border-left: 3px solid #ccc; margin: 10px 0; padding-left: 10px; color: #666; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-row"><span class="label">From:</span> ${from}</div>
        <div class="header-row"><span class="label">Sent:</span> ${date}</div>
        <div class="header-row"><span class="label">To:</span> ${to}</div>
        <div class="subject"><span class="label">Subject:</span> ${subject}</div>
      </div>
      <div class="body-container">
        ${bodyContent}
      </div>
    </body>
    </html>
  `;
}

// --- Modularized Attachment Handlers (Exported for Standalone Pipeline) ---

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
      console.log(
        `[Document Filter] Discarded Document ${docTitle}: Contains excluded keyword (Confidential/Privileged/CRO).`,
      );
      return false;
    }

    const mentionsSubject =
      criteria.length === 0 ||
      criteria.some((c) => rawText.includes(c.toLowerCase()));
    if (!mentionsSubject) {
      console.log(
        `[Document Filter] Discarded Document ${docTitle}: Data subject not mentioned.`,
      );
      return false;
    }

    // SEMANTIC HASHING: Hash the extracted text to catch duplicates with different binary timestamps
    if (processedHashes) {
      const contentHash = crypto
        .createHash("sha256")
        .update(rawText)
        .digest("hex");
      if (processedHashes.has(contentHash)) {
        console.log(
          `[Document Filter] Discarded Duplicate DOCX ${docTitle}: Identical inner text content.`,
        );
        return false;
      }
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

    await page.setContent(htmlContent, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.pdf({
      path: outputPath,
      format: "A4",
      margin: { top: "20mm", bottom: "20mm", left: "20mm", right: "20mm" },
      timeout: 45000,
    });
    return true;
  } catch (_err) {
    console.warn(
      `[PDF Converter] Skipping unreadable/oversized DOCX file: ${docTitle}`,
    );
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
        body { font-family: sans-serif; padding: 20px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 30px; table-layout: fixed; } 
        th, td { border: 1px solid #ddd; padding: 6px; font-size: 9px; text-align: left; word-wrap: break-word; overflow: hidden; } 
        th { background-color: #f2f2f2; font-weight: bold; }
        .highlight { background-color: #fff3cd; font-weight: bold; color: #856404; }
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
          if (totalRowsRendered >= MAX_ROWS) {
            htmlContent += `<tr><td colspan="${colCount}" style="text-align: center; color: red; font-weight: bold; padding: 10px;"><em>... Maximum PDF row limit reached to prevent memory crash. Remaining rows safely truncated. ...</em></td></tr>`;
            break;
          }
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

    if (!foundMatches) {
      console.log(
        `[Document Filter] Discarded Excel ${docTitle}: Data subject not mentioned.`,
      );
      return false;
    }

    // SEMANTIC HASHING: Hash the final HTML table generated from the spreadsheet.
    // If two different excel files result in the exact same filtered rows, they are duplicates!
    if (processedHashes) {
      const contentHash = crypto
        .createHash("sha256")
        .update(htmlContent)
        .digest("hex");
      if (processedHashes.has(contentHash)) {
        console.log(
          `[Document Filter] Discarded Duplicate Excel ${docTitle}: Identical inner table content.`,
        );
        return false;
      }
      processedHashes.add(contentHash);
    }

    htmlContent += `</body></html>`;

    await page.setContent(htmlContent, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.pdf({
      path: outputPath,
      format: "A4",
      landscape: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      timeout: 45000,
    });
    return true;
  } catch (_err) {
    console.warn(
      `[PDF Converter] Skipping unreadable/oversized Excel file: ${docTitle}`,
    );
    return false;
  }
}

export async function processPdfAttachment(
  buffer: Buffer,
  outputPath: string,
  criteria: string[],
  docTitle: string,
  processedHashes?: Set<string>,
): Promise<boolean> {
  try {
    const parser = new PDFParse({ data: buffer });
    try {
      const pdfData = await parser.getText();
      const rawText = pdfData.text.toLowerCase();

      const exclusions = ["confidential", "privileged", "cro"];
      if (exclusions.some((ex) => rawText.includes(ex))) {
        console.log(
          `[Attachment Filter] Discarded PDF ${docTitle}: Contains excluded keyword.`,
        );
        return false;
      }

      const mentionsSubject =
        criteria.length === 0 ||
        criteria.some((c) => rawText.includes(c.toLowerCase()));
      if (!mentionsSubject) {
        console.log(
          `[Attachment Filter] Discarded PDF ${docTitle}: Data subject not mentioned.`,
        );
        return false;
      }

      // SEMANTIC HASHING: Hash the extracted raw text of the PDF
      if (processedHashes) {
        const contentHash = crypto
          .createHash("sha256")
          .update(rawText)
          .digest("hex");
        if (processedHashes.has(contentHash)) {
          console.log(
            `[Attachment Filter] Discarded Duplicate PDF ${docTitle}: Identical inner text content.`,
          );
          return false;
        }
        processedHashes.add(contentHash);
      }

      fs.writeFileSync(outputPath, buffer);
      return true;
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    console.warn(
      `[Attachment Filter] Failed to parse PDF ${docTitle}. Saving raw file as fallback.`,
      err,
    );
    fs.writeFileSync(outputPath, buffer);
    return true;
  }
}

// --- Main Engine ---

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
  const deliverablesDir = path.join(targetFolder, "Emails");

  console.log(`\n=================================================`);
  console.log(
    `[PDF Engine] Initiating Conversion for Unified Case: ${cleanRelativePath}`,
  );

  if (!fs.existsSync(exportDir)) {
    console.error(
      `[PDF Engine] ❌ ERROR: Export directory missing at ${exportDir}`,
    );
    db.prepare(
      `UPDATE processed_files SET pdf_status = 'failed' WHERE id IN (${placeholders})`,
    ).run(...unifiedFileIds);
    return;
  }

  if (!fs.existsSync(deliverablesDir)) {
    fs.mkdirSync(deliverablesDir, { recursive: true });
  }

  console.log(`[PDF Engine] ✅ PDFs SAVING TO:`);
  console.log(`-> ${path.resolve(deliverablesDir)}`);
  console.log(`=================================================\n`);

  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    const page = await browser.newPage();

    const emlFiles = fs
      .readdirSync(exportDir)
      .filter((f) => f.endsWith(".eml"));
    console.log(
      `[PDF Engine] Found ${emlFiles.length} .eml files in the export folder.`,
    );

    let generatedPdfs = 0;
    let skippedPdfs = 0;
    let draftsSkipped = 0;
    let duplicateAttachmentsSkipped = 0;

    // We pass this into the semantic check to block identical data payloads
    const processedAttachmentHashes = new Set<string>();

    for (const filename of emlFiles) {
      const emlPath = path.join(exportDir, filename);
      const baseName = filename.replace(/\.eml$/i, "");
      const emailPdfPath = path.join(deliverablesDir, `${baseName}.pdf`);

      try {
        const rawEml = fs.readFileSync(emlPath);
        const parsed = await simpleParser(rawEml);

        const fromText = getAddressText(parsed.from);
        const toText = getAddressText(parsed.to);

        if (fromText === "Unknown" || toText === "Unknown") {
          console.log(
            `[PDF Engine] Skipping ${baseName}.pdf - Identified as Draft (Missing To/From)`,
          );
          draftsSkipped++;
          continue;
        }

        if (!fs.existsSync(emailPdfPath)) {
          const htmlContent = generateEmailHtml(
            parsed,
            fromText,
            toText,
            baseName,
          );

          try {
            await page.setContent(htmlContent, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            });
            await page.pdf({
              path: emailPdfPath,
              format: "A4",
              margin: {
                top: "20mm",
                bottom: "20mm",
                left: "20mm",
                right: "20mm",
              },
              printBackground: true,
              timeout: 45000,
            });
            generatedPdfs++;
            console.log(`[PDF Engine] Generated PDF: ${baseName}.pdf`);
          } catch (_pdfErr) {
            console.error(
              `[PDF Engine] Puppeteer failed to render ${baseName}.pdf, moving to next.`,
            );
          }
        } else {
          skippedPdfs++;
        }

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

            // 1. FAST BINARY CHECK: Drops identical images, zip files, or perfectly matching binary documents.
            const fileHash = crypto
              .createHash("sha256")
              .update(att.content)
              .digest("hex");
            if (processedAttachmentHashes.has(fileHash)) {
              duplicateAttachmentsSkipped++;
              console.log(
                `[PDF Engine] Dropped Duplicate Attachment: ${att.filename || "Unknown"} (Exact Binary Match)`,
              );
              continue;
            }
            processedAttachmentHashes.add(fileHash);

            const attSeqName = `${baseName} Attachment ${String(attachmentCounter).padStart(3, "0")}`;
            attachmentCounter++;

            // 2. SEMANTIC CONTENT CHECK: We pass processedAttachmentHashes in.
            // The functions will hash the extracted text and block it if the text matches an earlier file!
            if (ext === ".docx") {
              const docxPdfPath = path.join(
                deliverablesDir,
                `${attSeqName}.pdf`,
              );
              let success = true;

              if (!fs.existsSync(docxPdfPath)) {
                success = await processDocxToPdf(
                  att.content,
                  docxPdfPath,
                  filterCriteria,
                  page,
                  attSeqName,
                  processedAttachmentHashes,
                );
              }
              if (!success && fs.existsSync(docxPdfPath)) {
                fs.unlinkSync(docxPdfPath);
              }
            } else if (ext === ".doc") {
              const rawPath = path.join(deliverablesDir, `${attSeqName}${ext}`);
              if (!fs.existsSync(rawPath))
                fs.writeFileSync(rawPath, att.content);
            } else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
              const excelPdfPath = path.join(
                deliverablesDir,
                `${attSeqName}.pdf`,
              );
              let success = true;

              if (!fs.existsSync(excelPdfPath)) {
                success = await processExcelToPdf(
                  att.content,
                  excelPdfPath,
                  filterCriteria,
                  page,
                  attSeqName,
                  processedAttachmentHashes,
                );
              }
              if (!success && fs.existsSync(excelPdfPath)) {
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
            } else if (ext === ".zip") {
              const rawPath = path.join(deliverablesDir, `${attSeqName}${ext}`);
              if (!fs.existsSync(rawPath))
                fs.writeFileSync(rawPath, att.content);
            }
          }
        }
      } catch (err) {
        console.error(`Failed to process ${filename}:`, err);
      }
    }

    console.log(
      `[PDF Engine] Batch finished! Generated ${generatedPdfs} new PDFs. Skipped ${skippedPdfs} existing PDFs. Filtered ${draftsSkipped} drafts. Deduplicated ${duplicateAttachmentsSkipped} identical attachments.`,
    );

    const remainingFiles = fs.readdirSync(exportDir);
    for (const file of remainingFiles) {
      if (!file.endsWith(".eml")) {
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
    if (browser) await browser.close();
  }
}
