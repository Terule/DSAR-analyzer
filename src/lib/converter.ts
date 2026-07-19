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
import { getCasePstFileIds } from "./case-utils";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";
import { repairMojibake } from "./text-encoding";

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

function getAddressValues(
  addr: AddressObject | AddressObject[] | undefined,
): string[] {
  if (!addr) return [];
  const containers = Array.isArray(addr) ? addr : [addr];
  return containers
    .flatMap((container) => container.value ?? [])
    .map((entry) => (entry.address ?? "").toLowerCase())
    .filter(Boolean);
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

  // WeasyPrint can exit 0 yet leave an empty file when killed mid-write or on
  // certain edge cases. Reject empty output so callers don't ship 0-byte PDFs.
  let sizeOk = false;
  try {
    sizeOk = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0;
  } catch {
    sizeOk = false;
  }

  if (!sizeOk) {
    try {
      fs.rmSync(pdfPath, { force: true });
    } catch {
      // Ignore cleanup races.
    }
    throw new Error("WeasyPrint produced an empty PDF");
  }
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
  bypassKeywordFilter = false,
): Promise<boolean> {
  try {
    const textExtraction = await mammoth.extractRawText({ buffer });
    const sourceText = repairMojibake(textExtraction.value || "");
    const rawText = sourceText.toLowerCase();

    const exclusions = [
      "confidential",
      "confidentiality",
      "privileged",
      "cro",
      "cros",
    ];
    const exclusionsRegex = new RegExp(`\\b(${exclusions.join("|")})\\b`, "i");
    if (!bypassKeywordFilter && exclusionsRegex.test(rawText)) return false;

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
      `<html><head><title>${docTitle}</title><style>body { font-family: sans-serif; line-height: 1.6; padding: 20px; }</style></head><body>${repairMojibake(result.value || "")}</body></html>`,
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
  bypassKeywordFilter = false,
): Promise<boolean> {
  try {
    const escapeHtml = (value: string): string =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

    const toExcelColumnLabel = (index: number): string => {
      let n = index + 1;
      let label = "";
      while (n > 0) {
        const rem = (n - 1) % 26;
        label = String.fromCharCode(65 + rem) + label;
        n = Math.floor((n - 1) / 26);
      }
      return label;
    };

    const estimateColumnUnits = (values: string[]): number => {
      let maxLineLength = 0;
      for (const value of values) {
        for (const line of value.split(/\r?\n/)) {
          const len = line.trim().length;
          if (len > maxLineLength) maxLineLength = len;
        }
      }

      // Keep columns readable without letting one verbose cell dominate page width.
      const scaled = Math.ceil(maxLineLength * 0.8) + 4;
      return Math.max(10, Math.min(42, scaled));
    };

    const displayedCellValue = (
      sheet: xlsx.WorkSheet,
      row: number,
      column: number,
    ): string => {
      const cell = sheet[xlsx.utils.encode_cell({ r: row, c: column })];
      return cell ? repairMojibake(xlsx.utils.format_cell(cell)) : "";
    };

    const splitColumnsIntoPages = (
      units: number[],
      maxUnitsPerPage: number,
    ): number[][] => {
      const pages: number[][] = [];
      let current: number[] = [];
      let currentTotal = 0;

      for (let i = 0; i < units.length; i++) {
        const width = units[i] || 10;
        const wouldOverflow =
          current.length > 0 && currentTotal + width > maxUnitsPerPage;

        if (wouldOverflow) {
          pages.push(current);
          current = [i];
          currentTotal = width;
          continue;
        }

        current.push(i);
        currentTotal += width;
      }

      if (current.length > 0) pages.push(current);
      return pages;
    };

    const wb = xlsx.read(buffer, { type: "buffer" });
    let fullTextForExclusion = "";
    const loweredCriteria = criteria.map((c) => c.toLowerCase());

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
    if (!bypassKeywordFilter && exclusionsRegex.test(fullTextForExclusion))
      return false;

    let htmlContent = `
      <html><head><title>${docTitle}</title><style>
        @page { size: A4 landscape; margin: 8mm; }
        body { font-family: Arial, sans-serif; font-size: 8pt; padding: 0; }
        .sheet-page.page-break { break-before: page; page-break-before: always; }
        table { border-collapse: collapse; width: 100%; table-layout: fixed; margin-bottom: 12px; }
        thead { display: table-header-group; }
        tr { break-inside: avoid; page-break-inside: avoid; }
        th, td { border: 0.5px solid #d9d9d9; padding: 2px 4px; vertical-align: top; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; line-height: 1.15; }
        th { background-color: #f2f2f2; font-weight: bold; text-align: left; }
        .highlight { background-color: #fff3cd !important; }
        h1 { margin: 0 0 10px; font-size: 13px; }
        h2 { margin: 10px 0 6px; font-size: 11px; }
        h3 { margin: 6px 0 4px; font-size: 9pt; font-weight: 600; color: #555; }
      </style></head><body><h1>Redacted Spreadsheet</h1>
    `;

    let foundMatches = false;
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const range = sheet["!ref"]
        ? xlsx.utils.decode_range(sheet["!ref"])
        : null;
      if (!range) continue;
      const jsonData = Array.from(
        { length: range.e.r - range.s.r + 1 },
        (_, rowOffset) =>
          Array.from({ length: range.e.c - range.s.c + 1 }, (_, columnOffset) =>
            displayedCellValue(
              sheet,
              range.s.r + rowOffset,
              range.s.c + columnOffset,
            ),
          ),
      );
      if (jsonData.length === 0) continue;

      const headers = jsonData[0] || [];
      const matchedRows = jsonData
        .slice(1)
        .filter((row) =>
          loweredCriteria.length === 0
            ? true
            : row.some(
                (cell) =>
                  cell != null &&
                  loweredCriteria.some((c) =>
                    String(cell).toLowerCase().includes(c),
                  ),
              ),
        );

      if (matchedRows.length > 0) {
        foundMatches = true;
        const columnCount = Math.max(
          headers.length,
          ...matchedRows.map((row) => row.length),
        );
        if (columnCount === 0) continue;

        const normalizedHeaders = Array.from(
          { length: columnCount },
          (_, i) => {
            const raw = String(headers[i] ?? "").trim();
            return raw.length > 0 ? raw : `Column ${i + 1}`;
          },
        );

        const normalizedRows = matchedRows.map((row) =>
          Array.from({ length: columnCount }, (_, i) => String(row[i] ?? "")),
        );

        const sheetColumns = sheet["!cols"] || [];
        const columnUnits = normalizedHeaders.map((header, colIdx) => {
          const sourceColumn = range.s.c + colIdx;
          const excelWidth = sheetColumns[sourceColumn]?.wch;
          return excelWidth && excelWidth > 0
            ? Math.max(8, Math.min(42, Math.round(excelWidth)))
            : estimateColumnUnits([
                header,
                ...normalizedRows.map((row) => row[colIdx]),
              ]);
        });

        // Horizontal pagination: keep readable column widths and flow to next page
        // when the current set no longer fits within the printable width.
        const columnPages = splitColumnsIntoPages(columnUnits, 140);

        htmlContent += `<h2>Sheet: ${escapeHtml(sheetName)}</h2>`;
        for (let pageIdx = 0; pageIdx < columnPages.length; pageIdx++) {
          const pageColumns = columnPages[pageIdx];
          const totalUnits = pageColumns.reduce(
            (sum, colIdx) => sum + (columnUnits[colIdx] || 10),
            0,
          );
          const firstCol = toExcelColumnLabel(pageColumns[0]);
          const lastCol = toExcelColumnLabel(
            pageColumns[pageColumns.length - 1],
          );

          htmlContent += `<section class="sheet-page${pageIdx > 0 ? " page-break" : ""}">`;
          htmlContent += `<h3>Columns ${firstCol} to ${lastCol}</h3>`;
          htmlContent += `<table><colgroup>`;

          for (const colIdx of pageColumns) {
            const pct = ((columnUnits[colIdx] || 10) / totalUnits) * 100;
            htmlContent += `<col style="width:${pct.toFixed(2)}%" />`;
          }

          htmlContent += `</colgroup><thead><tr>`;
          for (const colIdx of pageColumns) {
            htmlContent += `<th>${escapeHtml(normalizedHeaders[colIdx])}</th>`;
          }
          htmlContent += `</tr></thead><tbody>`;

          for (const row of normalizedRows) {
            htmlContent += `<tr>`;
            for (const colIdx of pageColumns) {
              const cellVal = row[colIdx] || "";
              const escapedCellVal = escapeHtml(cellVal);
              const isMatch = loweredCriteria.some((c) =>
                cellVal.toLowerCase().includes(c),
              );
              htmlContent += `<td class="${isMatch ? "highlight" : ""}">${escapedCellVal}</td>`;
            }
            htmlContent += `</tr>`;
          }

          htmlContent += `</tbody></table></section>`;
        }
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
  bypassKeywordFilter = false,
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
    if (!bypassKeywordFilter && exclusionsRegex.test(rawText)) return false;

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
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: {
      filepath: true,
      subject_name: true,
      subject_email: true,
      subject_personal_email: true,
      subject_aliases: true,
    },
  });

  if (!row?.filepath) throw new Error(`File ID not found: ${fileId}`);

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  let relativeSystemPath = path.relative(stagingPath, row.filepath);
  if (
    relativeSystemPath.startsWith("..") ||
    path.isAbsolute(relativeSystemPath)
  )
    relativeSystemPath = fileId;

  let deliverableRelativePath = path.dirname(relativeSystemPath);
  if (deliverableRelativePath === "." || deliverableRelativePath === "")
    deliverableRelativePath = path.parse(relativeSystemPath).name;
  if (path.basename(deliverableRelativePath).toLowerCase() === "pst")
    deliverableRelativePath = path.dirname(deliverableRelativePath);
  const workingFolder = getPstWorkFolder({
    fileId,
    filepath: row.filepath,
    stagingPath,
    extractedPath: outputBaseDir,
  });
  const targetFolder = path.join(outputBaseDir, deliverableRelativePath);

  const uniqueEmailsFolder = path.join(workingFolder, ".unique-emails");
  const selectedDir = path.join(uniqueEmailsFolder, "selected");
  const rawEmailsDir = path.join(uniqueEmailsFolder, "raw-emails");
  const deliverablesDir = path.join(targetFolder, "Emails");
  const logsDir = path.join(targetFolder, ".logs");

  if (!fs.existsSync(selectedDir)) {
    console.error(
      `[Converter] Render failed for ${fileId}: selected emails folder not found at ${selectedDir}`,
    );
    const durationMs = Date.now() - startTime;
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { pdf_status: "failed", pdf_duration_ms: durationMs },
    });
    return;
  }

  if (!fs.existsSync(deliverablesDir))
    fs.mkdirSync(deliverablesDir, { recursive: true });
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  await prisma.processedFile.update({
    where: { id: fileId },
    data: { pdf_status: "processing" },
  });

  try {
    const emlFiles = fs
      .readdirSync(selectedDir)
      .filter((f) => f.toLowerCase().endsWith(".eml"))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      );

    const padLength = Math.max(4, emlFiles.length.toString().length);
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { pdf_total: emlFiles.length, pdf_processed: 0 },
    });
    let lastProgressWrite = 0;

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
    const subjectPersonalEmail = (row.subject_personal_email || "")
      .trim()
      .toLowerCase();

    // Shared attachment renderer — used for both normal and warning emails.
    const renderNestedAttachments = async (
      attachments: Attachment[],
      currentBaseName: string,
      outputDir: string,
      bypassKeywordFilter = false,
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
          await processDocxToPdf(
            contentBuf,
            path.join(outputDir, `${attSeqName}.pdf`),
            filterCriteria,
            attSeqName,
            undefined,
            bypassKeywordFilter,
          );
        } else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
          await processExcelToPdf(
            contentBuf,
            path.join(outputDir, `${attSeqName}.pdf`),
            filterCriteria,
            attSeqName,
            undefined,
            bypassKeywordFilter,
          );
        } else if (ext === ".pdf") {
          await processPdfAttachment(
            contentBuf,
            path.join(outputDir, `${attSeqName}${ext}`),
            filterCriteria,
            attSeqName,
            undefined,
            bypassKeywordFilter,
          );
        } else if (ext === ".zip") {
          const zipPath = path.join(outputDir, `${attSeqName}${ext}`);
          fs.writeFileSync(zipPath, contentBuf);
          const extractedDir = path.join(outputDir, `${attSeqName}_unzipped`);
          const extracted = await extractZipAttachment(zipPath, extractedDir);
          if (!extracted) {
            fs.rmSync(extractedDir, { recursive: true, force: true });
          }
        }
      }
    };

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
            // Bypass keyword filter when email was addressed to the subject's personal email.
            const toValues = getAddressValues(parsed.to);
            const bypassAttachmentKeywords =
              subjectPersonalEmail.length > 0 &&
              toValues.includes(subjectPersonalEmail);
            const processNestedAttachments = async (
              attachments: Attachment[],
              currentBaseName: string,
            ) => {
              await renderNestedAttachments(
                attachments,
                currentBaseName,
                deliverablesDir,
                bypassAttachmentKeywords,
              );
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
      const now = Date.now();
      if (idx === emlFiles.length - 1 || now - lastProgressWrite >= 1_000) {
        lastProgressWrite = now;
        await prisma.processedFile.update({
          where: { id: fileId },
          data: { pdf_processed: idx + 1 },
        });
      }
      await yieldToEventLoop();
    }

    // --- WARNING EMAILS: self-forwards (company → personal email) ---
    // These were tagged ai_decision = 'warning' during analysis and skipped AI.
    // Render them into Emails/Warning/ so reviewers can inspect them separately.
    const caseIdsForWarning = await getCasePstFileIds(fileId);
    const warningRecords = await prisma.email.findMany({
      where: {
        file_id: { in: caseIdsForWarning },
        ai_decision: "warning",
        is_duplicate: 0,
      },
      select: { email_hash: true },
    });

    if (warningRecords.length > 0) {
      const warningDir = path.join(deliverablesDir, "Warning");
      fs.mkdirSync(warningDir, { recursive: true });
      const warnPad = Math.max(4, warningRecords.length.toString().length);

      for (let wi = 0; wi < warningRecords.length; wi++) {
        const { email_hash } = warningRecords[wi];
        const emlPath = path.join(rawEmailsDir, `${email_hash}.eml`);
        if (!fs.existsSync(emlPath)) continue;

        const baseName = `Warning ${String(wi + 1).padStart(warnPad, "0")}`;
        const pdfPath = path.join(warningDir, `${baseName}.pdf`);

        try {
          await withTimeout(
            (async () => {
              const rawEml = fs.readFileSync(emlPath);
              const parsed = await simpleParser(rawEml);
              const fromText = getAddressText(parsed.from);
              const toText = getAddressText(parsed.to);

              if (!fs.existsSync(pdfPath)) {
                const htmlContent = generateEmailHtml(
                  parsed,
                  fromText,
                  toText,
                  baseName,
                );
                const tempHtml = `${pdfPath}.tmp.html`;
                fs.writeFileSync(tempHtml, htmlContent);
                try {
                  await runWeasyPrint(tempHtml, pdfPath);
                } finally {
                  fs.rmSync(tempHtml, { force: true });
                }
              }

              if (parsed.attachments && parsed.attachments.length > 0) {
                await renderNestedAttachments(
                  parsed.attachments,
                  baseName,
                  warningDir,
                  true, // self-forwards are addressed to personal email — bypass keyword filter
                );
              }
            })(),
            PER_EMAIL_TIMEOUT_MS,
            `Warning email render (${email_hash})`,
          );
        } catch (err) {
          console.error(
            `Skipping warning email ${email_hash}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        await yieldToEventLoop();
      }
    }

    const durationMs = Date.now() - startTime;
    // Render covers the whole case's shared selected/ folder, so mark every PST
    // row in the case completed in one pass. Record the real duration only on
    // the row that actually rendered (0 on siblings) so the telemetry sum stays
    // accurate. Both updates run in a single transaction to avoid a half-updated case.
    const caseIds = await getCasePstFileIds(fileId);
    const siblingIds = caseIds.filter((id) => id !== fileId);
    await prisma.$transaction([
      prisma.processedFile.update({
        where: { id: fileId },
        data: {
          pdf_status: "completed",
          pdf_duration_ms: durationMs,
          pdf_processed: emlFiles.length,
        },
      }),
      ...(siblingIds.length > 0
        ? [
            prisma.processedFile.updateMany({
              where: { id: { in: siblingIds } },
              data: {
                pdf_status: "completed",
                pdf_duration_ms: 0,
                pdf_total: 0,
                pdf_processed: 0,
              },
            }),
          ]
        : []),
    ]);
    // Once Render succeeds, the final PDFs no longer depend on raw EMLs or
    // batch payloads. Remove the hidden work tree to reclaim disk space.
    fs.rmSync(workingFolder, { recursive: true, force: true });
  } catch (error) {
    console.error(
      `[Converter] Render failed for ${fileId}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    const durationMs = Date.now() - startTime;
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { pdf_status: "failed", pdf_duration_ms: durationMs },
    });
  }
}
