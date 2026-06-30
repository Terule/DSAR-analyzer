import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AddressObject,
  type Attachment,
  type ParsedMail,
  simpleParser,
} from "mailparser";
import mammoth from "mammoth";
import * as xlsx from "xlsx";
import { db } from "./db";

const FONT_FOLDER =
  process.env.PDF_FONT_DIR || path.join(process.cwd(), "fonts");

function toFontUrl(fileName: string): string {
  return pathToFileURL(path.join(FONT_FOLDER, fileName)).toString();
}

function hasAptosCoreSet(): boolean {
  const required = [
    "Aptos.ttf",
    "Aptos-Bold.ttf",
    "Aptos-Italic.ttf",
    "Aptos-Bold-Italic.ttf",
  ];
  return required.every((name) => fs.existsSync(path.join(FONT_FOLDER, name)));
}

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

function sanitizeFontsForPdf(html: string): string {
  let sanitized = html;

  // Normalize PST/Outlook-heavy markup before font/layout sanitization.
  sanitized = sanitized
    // Remove VML/Office blocks that frequently create large invisible spacers.
    .replace(/<v:[^>]*>[\s\S]*?<\/v:[^>]*>/gi, "")
    .replace(/<o:[^>]*>[\s\S]*?<\/o:[^>]*>/gi, "")
    .replace(/<w:[^>]*>[\s\S]*?<\/w:[^>]*>/gi, "")
    .replace(/<xml[^>]*>[\s\S]*?<\/xml>/gi, "")
    // Strip legacy font tags/attributes that can trigger bad font metadata embedding.
    .replace(/<\/?font\b[^>]*>/gi, "")
    .replace(/\sface\s*=\s*(["']).*?\1/gi, "")
    // Remove top-level spacer rows/cells often exported by Outlook HTML.
    .replace(
      /<tr[^>]*>\s*<t[dh][^>]*(?:height|style="[^"]*(?:height|min-height|padding-top|margin-top)[^"]*")[^>]*>\s*(?:&nbsp;|<br\s*\/?>|\s)*<\/t[dh]>\s*<\/tr>/gi,
      "",
    )
    .replace(/<img[^>]*(?:spacer|pixel|transparent|blank)[^>]*>/gi, "");

  // Remove Outlook/MSO conditional blocks and generic HTML comments.
  sanitized = sanitized
    .replace(/<!--\[if [\s\S]*?\]>[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Remove embedded font definitions that can produce invalid font metadata.
  sanitized = sanitized.replace(/@font-face\s*\{[\s\S]*?\}/gi, "");

  // Remove explicit font-family declarations from inline style attributes.
  sanitized = sanitized.replace(/font-family\s*:[^;"']*;?/gi, "");

  // Remove Outlook mso-* directives known to affect pagination and spacing.
  sanitized = sanitized.replace(/mso-[a-z-]+\s*:[^;"']*;?/gi, "");

  // Strip forced page breaks that can leave a near-empty first page.
  sanitized = sanitized.replace(
    /(?:page-)?break-(?:before|after|inside)\s*:[^;"']*;?/gi,
    "",
  );

  // Strip explicit min-height/height declarations that inflate layout height.
  sanitized = sanitized.replace(/min-height\s*:[^;"']*;?/gi, "");
  sanitized = sanitized.replace(/\bheight\s*:[^;"']*;?/gi, "");

  // Collapse runs of empty paragraphs / line breaks that push content down.
  sanitized = sanitized.replace(/(?:\s*<br\s*\/?>\s*){3,}/gi, "<br><br>");
  sanitized = sanitized.replace(/<p[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "");
  sanitized = sanitized.replace(
    /<div[^>]*style="[^"]*margin[^"]*"[^>]*><\/div>/gi,
    "",
  );
  sanitized = sanitized.replace(
    /^(?:\s|&nbsp;|<br\s*\/?>|<p[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>){2,}/i,
    "",
  );

  const aptosEnabled = hasAptosCoreSet();
  const fontFaceCss = aptosEnabled
    ? `
      @font-face {
        font-family: "AptosCustom";
        src: url("${toFontUrl("Aptos.ttf")}") format("truetype");
        font-weight: 400;
        font-style: normal;
      }
      @font-face {
        font-family: "AptosCustom";
        src: url("${toFontUrl("Aptos-Bold.ttf")}") format("truetype");
        font-weight: 700;
        font-style: normal;
      }
      @font-face {
        font-family: "AptosCustom";
        src: url("${toFontUrl("Aptos-Italic.ttf")}") format("truetype");
        font-weight: 400;
        font-style: italic;
      }
      @font-face {
        font-family: "AptosCustom";
        src: url("${toFontUrl("Aptos-Bold-Italic.ttf")}") format("truetype");
        font-weight: 700;
        font-style: italic;
      }
    `
    : "";

  const baseFontStack = aptosEnabled
    ? '"AptosCustom", "Helvetica Neue", Helvetica, Arial, sans-serif'
    : '"Helvetica Neue", Helvetica, Arial, sans-serif';

  // Force a stable font stack and neutralize layout-inflating styles.
  const fontOverride = `
    <style>
      ${fontFaceCss}
      @page { size: A4; margin: 18mm; }
      html, body, * {
        font-family: ${baseFontStack} !important;
        min-height: 0 !important;
        page-break-before: auto !important;
        page-break-after: auto !important;
        break-before: auto !important;
        break-after: auto !important;
      }
      html, body {
        height: auto !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      table { page-break-inside: auto !important; }
    </style>
  `;

  if (/<head[^>]*>/i.test(sanitized)) {
    sanitized = sanitized.replace(/(<head[^>]*>)/i, `$1\n${fontOverride}`);
  } else {
    sanitized = `<!DOCTYPE html><html><head>${fontOverride}</head><body>${sanitized}</body></html>`;
  }

  return sanitized;
}

export function normalizeHtmlForPdf(html: string): string {
  return sanitizeFontsForPdf(html);
}

// 🔥 Pure WeasyPrint CLI Exec Wrapper (Zero Puppeteer)
const MAX_CONCURRENT_SUBPROCESSES = 2;
let activeSubprocesses = 0;
const subprocessQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeSubprocesses < MAX_CONCURRENT_SUBPROCESSES) {
    activeSubprocesses++;
    return Promise.resolve();
  }
  return new Promise((resolve) => subprocessQueue.push(resolve));
}

function releaseSlot(): void {
  const next = subprocessQueue.shift();
  if (next) {
    next();
  } else {
    activeSubprocesses--;
  }
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  return acquireSlot().then(
    () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: "ignore" });
        let done = false;

        const finish = (cb: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          releaseSlot();
          cb();
        };

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(() =>
            reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          );
        }, timeoutMs);

        child.once("error", (err) => {
          finish(() => {
            reject(
              new Error(
                `${label} failed to start: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          });
        });

        child.once("close", (code, signal) => {
          if (code === 0) {
            finish(resolve);
            return;
          }

          finish(() => {
            reject(
              new Error(
                `${label} exited with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}`,
              ),
            );
          });
        });
      }),
  );
}

async function runWeasyPrint(htmlPath: string, pdfPath: string) {
  await runCommand(
    "weasyprint",
    [htmlPath, pdfPath],
    120_000,
    "WeasyPrint execution",
  );
}

async function extractZipAttachment(zipPath: string, outputDir: string) {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    await runCommand(
      "unzip",
      ["-oq", zipPath, "-d", outputDir],
      60_000,
      "ZIP extraction",
    );
    return true;
  } catch (_err) {
    return false;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Hard per-file budget: skip an email if it takes too long to render.
const PER_EMAIL_TIMEOUT_MS = 60_000;

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
  return sanitizeFontsForPdf(html);
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
    const htmlContent = sanitizeFontsForPdf(
      `<html><head><title>${docTitle}</title><style>body { font-family: sans-serif; line-height: 1.6; padding: 20px; }</style></head><body>${result.value || ""}</body></html>`,
    );

    const tempHtmlPath = `${outputPath}.tmp.html`;
    fs.writeFileSync(tempHtmlPath, htmlContent);
    try {
      await runWeasyPrint(tempHtmlPath, outputPath);
    } finally {
      fs.rmSync(tempHtmlPath, { force: true });
    }

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
        @page { size: A4 landscape; margin: 8mm; }
        body { font-family: Arial, sans-serif; font-size: 8pt; padding: 4px; }
        table { border-collapse: collapse; width: 100%; table-layout: auto; margin-bottom: 16px; }
        th, td { border: 0.5px solid #ccc; padding: 3px 4px; vertical-align: top; word-break: break-word; white-space: normal; }
        th { background-color: #f8f8f8; font-weight: bold; }
        .highlight { background-color: #fff3cd !important; }
        h1 { margin: 0 0 10px; font-size: 13px; }
        h2 { margin: 10px 0 6px; font-size: 11px; }
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
    htmlContent = sanitizeFontsForPdf(htmlContent);
    const tempHtmlPath = `${outputPath}.tmp.html`;
    fs.writeFileSync(tempHtmlPath, htmlContent);
    try {
      await runWeasyPrint(tempHtmlPath, outputPath);
    } finally {
      fs.rmSync(tempHtmlPath, { force: true });
    }

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
  const uniqueEmailsFolder = path.join(targetFolder, ".unique-emails");
  const selectedDir = path.join(uniqueEmailsFolder, "selected");
  const deliverablesDir = path.join(targetFolder, "Emails");
  const logsDir = path.join(targetFolder, ".logs");

  if (!fs.existsSync(selectedDir)) {
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
      .readdirSync(selectedDir)
      .filter((f) => f.toLowerCase().endsWith(".eml"))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      );

    const padLength = Math.max(4, emlFiles.length.toString().length);

    const filterCriteriaSet = new Set<string>();
    if (row.subject_aliases) {
      row.subject_aliases.split(",").forEach((a) => {
        const alias = a.trim().toLowerCase();
        if (alias) filterCriteriaSet.add(alias);
      });
    }
    if (row.subject_name) filterCriteriaSet.add(row.subject_name.toLowerCase());
    if (row.subject_email)
      filterCriteriaSet.add(row.subject_email.toLowerCase());

    const filterCriteria = Array.from(filterCriteriaSet);

    for (let idx = 0; idx < emlFiles.length; idx++) {
      const filename = emlFiles[idx];
      const emlPath = path.join(selectedDir, filename);
      const baseName = `Email ${String(idx + 1).padStart(padLength, "0")}`;
      const emailPdfPath = path.join(deliverablesDir, `${baseName}.pdf`);

      try {
        await withTimeout(
          (async () => {
            const rawEml = fs.readFileSync(emlPath);
            const parsed = await simpleParser(rawEml);

            const fromText = getAddressText(parsed.from);
            const toText = getAddressText(parsed.to);

            if (fromText === "Unknown" || toText === "Unknown") return;

            if (!fs.existsSync(emailPdfPath)) {
              const htmlContent = generateEmailHtml(
                parsed,
                fromText,
                toText,
                baseName,
              );
              const tempHtml = `${emailPdfPath}.tmp.html`;
              fs.writeFileSync(tempHtml, htmlContent);
              try {
                await runWeasyPrint(tempHtml, emailPdfPath);
              } finally {
                fs.rmSync(tempHtml, { force: true });
              }
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
                  const docxPdfPath = path.join(
                    deliverablesDir,
                    `${attSeqName}.pdf`,
                  );
                  await processDocxToPdf(
                    contentBuf,
                    docxPdfPath,
                    filterCriteria,
                    attSeqName,
                  );
                } else if (
                  ext === ".xlsx" ||
                  ext === ".xls" ||
                  ext === ".csv"
                ) {
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
                  const pdfPath = path.join(
                    deliverablesDir,
                    `${attSeqName}${ext}`,
                  );
                  await processPdfAttachment(
                    contentBuf,
                    pdfPath,
                    filterCriteria,
                    attSeqName,
                  );
                } else if (ext === ".zip") {
                  const zipPath = path.join(
                    deliverablesDir,
                    `${attSeqName}${ext}`,
                  );
                  fs.writeFileSync(zipPath, contentBuf);
                  const extractedDir = path.join(
                    deliverablesDir,
                    `${attSeqName}_unzipped`,
                  );
                  const extracted = await extractZipAttachment(
                    zipPath,
                    extractedDir,
                  );
                  if (!extracted) {
                    // Keep original zip when extraction tool is unavailable or archive is invalid.
                    fs.rmSync(extractedDir, { recursive: true, force: true });
                  }
                }
              }
            };

            if (parsed.attachments && parsed.attachments.length > 0) {
              await processNestedAttachments(parsed.attachments, baseName);
            }
          })(),
          PER_EMAIL_TIMEOUT_MS,
          `Email render (${filename})`,
        );
      } catch (err) {
        console.error(
          `Skipping ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Keep the API server responsive while processing large batches.
      await yieldToEventLoop();
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
