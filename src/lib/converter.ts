import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AddressObject,
  type Attachment,
  type ParsedMail,
  simpleParser,
} from "mailparser";
import mammoth from "mammoth";
import * as xlsx from "xlsx";
import { db } from "./db";

function getAddressText(
  addr: AddressObject | AddressObject[] | undefined,
): string {
  if (!addr) return "Unknown";
  if (Array.isArray(addr)) {
    const text = addr.map((a) => a.text).join(", ");
    return text.trim() || "Unknown";
  }
  return addr.text?.trim() || "Unknown";
}

// 🔥 Pure WeasyPrint CLI Exec Wrapper (Zero Puppeteer)
function runWeasyPrint(htmlPath: string, pdfPath: string) {
  try {
    execSync(`weasyprint "${htmlPath}" "${pdfPath}"`, { stdio: "ignore" });
  } catch (err) {
    throw new Error(
      `WeasyPrint execution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const pdfData = await parser.getText();
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

  let html: string = parsedEmail.html || parsedEmail.textAsHtml || "";

  if (html) {
    html = html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, "");
    if (html.match(/<body[^>]*>/i)) {
      html = html.replace(/(<body[^>]*>)/i, `$1\n${headerHtml}`);
    } else {
      html = `${headerHtml}\n${html}`;
    }
  } else {
    const plainText = parsedEmail.text || "(No body content)";
    html = `<!DOCTYPE html><html><head><title>${docTitle}</title></head><body style="font-family: sans-serif; padding: 20px;">${headerHtml}<pre style="white-space: pre-wrap; font-family: sans-serif;">${plainText}</pre></body></html>`;
  }

  // Embedded CID images replacement
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
          const cidRegex = new RegExp(
            `cid:${cid.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`,
            "gi",
          );
          html = html.replace(cidRegex, dataUri);
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
  docTitle: string,
  processedHashes?: Set<string>,
): Promise<boolean> {
  try {
    const textExtraction = await mammoth.extractRawText({ buffer });
    const rawText = (textExtraction.value || "").toLowerCase();

    const exclusions = [
      "confidential",
      "confidentiality",
      "privileged",
      "cro",
      "cros",
    ];
    const exclusionsRegex = new RegExp(`\\b(${exclusions.join("|")})\\b`, "i");
    if (exclusionsRegex.test(rawText)) return false;

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

    const result = await mammoth.convertToHtml({ buffer });
    const htmlContent = `<html><head><title>${docTitle}</title><style>body { font-family: sans-serif; line-height: 1.6; padding: 20px; }</style></head><body>${result.value || ""}</body></html>`;

    const tempHtmlPath = `${outputPath}.tmp.html`;
    fs.writeFileSync(tempHtmlPath, htmlContent);
    runWeasyPrint(tempHtmlPath, outputPath);
    fs.unlinkSync(tempHtmlPath);

    return true;
  } catch (_err) {
    return false;
  }
}

export async function processExcelToPdf(
  buffer: Buffer,
  outputPath: string,
  criteria: string[],
  docTitle: string,
  processedHashes?: Set<string>,
): Promise<boolean> {
  try {
    const wb = xlsx.read(buffer, { type: "buffer" });
    let fullTextForExclusion = "";

    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(sheet, {
        header: 1,
      }) as string[][];
      for (const row of jsonData) {
        fullTextForExclusion += `${row.join(" ")} `;
      }
    }

    const exclusions = [
      "confidential",
      "confidentiality",
      "privileged",
      "cro",
      "cros",
    ];
    const exclusionsRegex = new RegExp(`\\b(${exclusions.join("|")})\\b`, "i");
    if (exclusionsRegex.test(fullTextForExclusion)) return false;

    let htmlContent = `
      <html><head><title>${docTitle}</title><style>
        @page { size: A4 landscape; margin: 10mm; }
        body { font-family: sans-serif; font-size: 8pt; padding: 5px; }
        table { border-collapse: collapse; width: 100%; table-layout: fixed; margin-bottom: 20px; }
        th, td { border: 0.5px solid #ccc; padding: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        th { background-color: #f8f8f8; font-weight: bold; }
        .highlight { background-color: #fff3cd !important; }
      </style></head><body><h1>Redacted Spreadsheet</h1>
    `;

    let foundMatches = false;
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(sheet, {
        header: 1,
      }) as string[][];
      if (jsonData.length === 0) continue;

      const headers = jsonData[0] || [];
      const matchedRows = jsonData
        .slice(1)
        .filter((row) =>
          row.some(
            (cell) =>
              cell != null &&
              criteria.some((c) => String(cell).toLowerCase().includes(c)),
          ),
        );

      if (matchedRows.length > 0) {
        foundMatches = true;
        htmlContent += `<h2>Sheet: ${sheetName}</h2><table><thead><tr>`;
        for (const h of headers)
          htmlContent += `<th>${String(h).replace(/</g, "&lt;")}</th>`;
        htmlContent += `</tr></thead><tbody>`;

        for (const row of matchedRows) {
          htmlContent += `<tr>`;
          for (const cell of row) {
            const cellVal = String(cell || "").replace(/</g, "&lt;");
            const isMatch = criteria.some((c) =>
              cellVal.toLowerCase().includes(c),
            );
            htmlContent += `<td class="${isMatch ? "highlight" : ""}">${cellVal}</td>`;
          }
          htmlContent += `</tr>`;
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
    const tempHtmlPath = `${outputPath}.tmp.html`;
    fs.writeFileSync(tempHtmlPath, htmlContent);
    runWeasyPrint(tempHtmlPath, outputPath);
    fs.unlinkSync(tempHtmlPath);

    return true;
  } catch (_err) {
    return false;
  }
}

export async function processPdfAttachment(
  buffer: Buffer,
  outputPath: string,
  criteria: string[],
  _docTitle: string,
  processedHashes?: Set<string>,
): Promise<boolean> {
  try {
    const rawText = (await extractPdfText(buffer)).toLowerCase();
    const exclusions = [
      "confidential",
      "confidentiality",
      "privileged",
      "cro",
      "cros",
    ];
    const exclusionsRegex = new RegExp(`\\b(${exclusions.join("|")})\\b`, "i");
    if (exclusionsRegex.test(rawText)) return false;

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
    return false;
  }
}

export async function convertToPdfBatch(
  fileId: string,
  outputBaseDir: string = process.env.EXTRACTED_PATH ||
    "/Users/rgomes/Projects/extracted_emails",
) {
  const startTime = Date.now();
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
  )
    relativeSystemPath = fileId;

  let cleanRelativePath = path.dirname(relativeSystemPath);
  if (cleanRelativePath === "." || cleanRelativePath === "")
    cleanRelativePath = path.parse(relativeSystemPath).name;

  const targetFolder = path.join(outputBaseDir, cleanRelativePath);
  const exportDir = path.join(targetFolder, "export");
  const deliverablesDir = path.join(targetFolder, "Deliverables");
  const logsDir = path.join(targetFolder, "logs");

  if (!fs.existsSync(exportDir)) {
    const durationMs = Date.now() - startTime;
    db.prepare(
      "UPDATE processed_files SET pdf_status = 'failed', pdf_duration_ms = ? WHERE id = ?",
    ).run(durationMs, fileId);
    return;
  }

  if (!fs.existsSync(deliverablesDir))
    fs.mkdirSync(deliverablesDir, { recursive: true });
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  db.prepare(
    "UPDATE processed_files SET pdf_status = 'processing' WHERE id = ?",
  ).run(fileId);

  try {
    const emlFiles = fs
      .readdirSync(exportDir)
      .filter((f) => f.toLowerCase().endsWith(".eml"))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      );

    const filterCriteria: string[] = [];
    if (row.subject_name) filterCriteria.push(row.subject_name.toLowerCase());
    if (row.subject_email) filterCriteria.push(row.subject_email.toLowerCase());
    if (row.subject_aliases) {
      row.subject_aliases.split(",").forEach((a) => {
        const alias = a.trim().toLowerCase();
        if (alias) filterCriteria.push(alias);
      });
    }

    for (const filename of emlFiles) {
      const emlPath = path.join(exportDir, filename);
      const baseName = filename.replace(/\.eml$/i, "");
      const emailPdfPath = path.join(deliverablesDir, `${baseName}.pdf`);

      const rawEml = fs.readFileSync(emlPath);
      const parsed = await simpleParser(rawEml);

      const fromText = getAddressText(parsed.from);
      const toText = getAddressText(parsed.to);

      if (fromText === "Unknown" || toText === "Unknown") continue;

      if (!fs.existsSync(emailPdfPath)) {
        const htmlContent = generateEmailHtml(
          parsed,
          fromText,
          toText,
          baseName,
        );
        const tempHtml = `${emailPdfPath}.tmp.html`;
        fs.writeFileSync(tempHtml, htmlContent);
        runWeasyPrint(tempHtml, emailPdfPath);
        fs.unlinkSync(tempHtml);
      }

      // Process Flattened Attachments
      const processNestedAttachments = async (
        attachments: Attachment[],
        currentBaseName: string,
      ) => {
        let attachmentCounter = 1;
        const padLen = Math.max(2, attachments.length.toString().length);

        for (const att of attachments) {
          if (!att || !att.content) continue;
          const ext = path.extname(att.filename || "").toLowerCase();
          const contentBuf = Buffer.isBuffer(att.content)
            ? att.content
            : Buffer.from(att.content);

          const attSeqName = `${currentBaseName} Attachment ${String(attachmentCounter).padStart(padLen, "0")}`;
          attachmentCounter++;

          const allowedExtensions = [
            ".zip",
            ".pdf",
            ".docx",
            ".doc",
            ".xlsx",
            ".xls",
            ".csv",
          ];
          if (!allowedExtensions.includes(ext)) continue;

          if (ext === ".docx" || ext === ".doc") {
            const docxPdfPath = path.join(deliverablesDir, `${attSeqName}.pdf`);
            await processDocxToPdf(
              contentBuf,
              docxPdfPath,
              filterCriteria,
              attSeqName,
            );
          } else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
            const excelPdfPath = path.join(
              deliverablesDir,
              `${attSeqName}.pdf`,
            );
            await processExcelToPdf(
              contentBuf,
              excelPdfPath,
              filterCriteria,
              attSeqName,
            );
          } else if (ext === ".pdf") {
            const pdfPath = path.join(deliverablesDir, `${attSeqName}${ext}`);
            await processPdfAttachment(
              contentBuf,
              pdfPath,
              filterCriteria,
              attSeqName,
            );
          } else if (ext === ".zip") {
            const rawPath = path.join(deliverablesDir, `${attSeqName}${ext}`);
            fs.writeFileSync(rawPath, contentBuf);
          }
        }
      };

      if (parsed.attachments && parsed.attachments.length > 0) {
        await processNestedAttachments(parsed.attachments, baseName);
      }
    }

    const durationMs = Date.now() - startTime;
    db.prepare(
      "UPDATE processed_files SET pdf_status = 'completed', pdf_duration_ms = ? WHERE id = ?",
    ).run(durationMs, fileId);
  } catch (_error) {
    const durationMs = Date.now() - startTime;
    db.prepare(
      "UPDATE processed_files SET pdf_status = 'failed', pdf_duration_ms = ? WHERE id = ?",
    ).run(durationMs, fileId);
  }
}
