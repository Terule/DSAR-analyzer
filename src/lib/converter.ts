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
import { PRIVILEGED_KEYWORDS_RE } from "./exclusions";
import { archiveCompletedCase } from "./history";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";
import { queueSharePointArtifacts } from "./sharepoint-artifact-outbox";
import { startSharePointArtifactWorker } from "./sharepoint-artifact-queue";
import { normalizeSpreadsheetText, repairMojibake } from "./text-encoding";

const FONT_FOLDER =
  process.env.PDF_FONT_DIR || path.join(process.cwd(), "fonts");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A direct recipient remains responsive despite a boilerplate legal footer. */
function hasDirectRecipientAddress(text: string, criteria: string[]): boolean {
  const emails = criteria.filter((criterion) => criterion.includes("@"));
  return emails.some((email) =>
    new RegExp(
      `\\b(?:to|cc|bcc)\\s*:\\s*[^\\n]{0,240}${escapeRegExp(email)}`,
      "i",
    ).test(text),
  );
}

interface SpreadsheetCellValue {
  row: number;
  column: number;
  value: string;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

/**
 * Some Salesforce exports write literal values as `<c t="str"><v>…</v></c>`.
 * SheetJS intentionally treats those as formula-string cells and can omit
 * their values when no formula is present. Read only those missing cells from
 * the OOXML worksheet so the normal parser remains the primary source.
 */
function readMissingStringCells(
  buffer: Buffer,
  sheetIndex: number,
  existing: Map<string, SpreadsheetCellValue>,
): Map<string, SpreadsheetCellValue> {
  try {
    const packageFiles = xlsx.CFB.read(buffer, { type: "buffer" });
    const sheetPath = `Root Entry/xl/worksheets/sheet${sheetIndex + 1}.xml`;
    const entry = xlsx.CFB.find(packageFiles, sheetPath);
    if (!entry?.content) return existing;

    const xml = Buffer.from(entry.content).toString("utf-8");
    // Alternation consumes self-closing cells (`<c r="A1" s="2"/>`) on
    // their own so they cannot swallow the next real cell.
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const match of xml.matchAll(cellPattern)) {
      const [, attributes, content] = match;
      if (content === undefined) continue;
      if (!/\bt=(?:"str"|'str')/.test(attributes)) continue;

      const address = /\br=(?:"([A-Z]+\d+)"|'([A-Z]+\d+)')/i.exec(
        attributes,
      )?.[1];
      const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(content)?.[1];
      if (!address || rawValue === undefined || existing.has(address)) continue;

      const position = xlsx.utils.decode_cell(address);
      const value = normalizeSpreadsheetText(decodeXmlText(rawValue)).trim();
      if (value.length > 0) {
        existing.set(address, {
          row: position.r,
          column: position.c,
          value,
        });
      }
    }
  } catch {
    // A malformed package should retain the standard SheetJS behavior.
  }

  return existing;
}

function readSpreadsheetCells(
  buffer: Buffer,
  workbook: xlsx.WorkBook,
): Map<string, SpreadsheetCellValue[]> {
  const cellsBySheet = new Map<string, SpreadsheetCellValue[]>();

  for (const [sheetIndex, sheetName] of workbook.SheetNames.entries()) {
    const cellsByAddress = new Map<string, SpreadsheetCellValue>();
    for (const [address, cell] of Object.entries(
      workbook.Sheets[sheetName] || {},
    )) {
      if (address.startsWith("!") || !cell) continue;

      const position = xlsx.utils.decode_cell(address);
      const value = normalizeSpreadsheetText(
        xlsx.utils.format_cell(cell as xlsx.CellObject),
      ).trim();
      if (value.length > 0) {
        cellsByAddress.set(address, {
          row: position.r,
          column: position.c,
          value,
        });
      }
    }

    readMissingStringCells(buffer, sheetIndex, cellsByAddress);
    cellsBySheet.set(
      sheetName,
      [...cellsByAddress.values()].sort((left, right) =>
        left.row === right.row
          ? left.column - right.column
          : left.row - right.row,
      ),
    );
  }

  return cellsBySheet;
}

function isHtmlBodyColumn(header: string): boolean {
  return /(?:^|[_\s])html(?:[_\s]|$)|htmlbody|bodyhtml/i.test(header);
}

/**
 * CRM email exports commonly store a full HTML email in a spreadsheet cell.
 * Rendering that source literally exposes invisible Litmus preheader markup
 * (often thousands of zero-width spaces) as blank lines. Convert only those
 * recognised HTML-body fields to readable text before the spreadsheet PDF is
 * generated; every other cell retains its original value.
 */
function normalizeHtmlSpreadsheetBody(value: string): string {
  const withoutHiddenContent = value
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(
      /<([a-z][\w:-]*)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*display\s*:\s*none)[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    );

  const text = withoutHiddenContent
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replaceAll("&nbsp;", " ")
    .replaceAll("&zwnj;", "")
    .replaceAll("&shy;", "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&lsquo;", "‘")
    .replaceAll("&rsquo;", "’")
    .replaceAll("&ldquo;", "“")
    .replaceAll("&rdquo;", "”")
    .replaceAll("&ndash;", "–")
    .replaceAll("&mdash;", "—")
    .replaceAll("&hellip;", "…")
    .replaceAll("&copy;", "©")
    .replaceAll("&reg;", "®")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");

  return normalizeSpreadsheetText(text);
}

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
        max-width: 100% !important;
        overflow-wrap: anywhere !important;
      }
      /* Some Outlook exports put the fixed width or nowrap on a nested div,
         paragraph, or span rather than the table cell. Constrain descendants
         too, otherwise their intrinsic width can still make a parent table
         overflow the printable area. Preserve explicit preformatted content
         below, but re-enable normal wrapping for regular email markup. */
      body * {
        min-width: 0 !important;
        max-width: 100% !important;
        overflow-wrap: anywhere !important;
        word-wrap: break-word !important;
        word-break: break-all !important;
      }
      body :not(pre) {
        white-space: normal !important;
      }
      /* Outlook frequently uses fixed-width layout tables that are wider than
         the printable A4 area. Give every table a fixed layout inside the
         available width so WeasyPrint reflows it instead of clipping its right
         edge. This also covers tables nested inside the email body. */
      table {
        width: 100% !important;
        max-width: 100% !important;
        table-layout: fixed !important;
        page-break-inside: auto !important;
      }
      table, td, th {
        box-sizing: border-box !important;
        max-width: 100% !important;
      }
      td, th, pre {
        white-space: pre-wrap !important;
        overflow-wrap: break-word !important;
        word-wrap: break-word !important;
        word-break: break-all !important;
      }
      /* Outlook HTML often carries absolute image dimensions far wider than
         an A4 page. Constrain only the rendered image, retaining its aspect
         ratio so normal signatures and inline content keep their native size. */
      img {
        /* Inline email images are overwhelmingly signatures/logos. Outlook
           often supplies their original pixel dimensions, which can consume
           an entire A4 page in WeasyPrint. Attachments are exported separately
           so keep inline images deliberately signature-sized. */
        display: inline-block !important;
        width: auto !important;
        height: auto !important;
        max-width: 55mm !important;
        max-height: 38mm !important;
        object-fit: contain !important;
      }
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

    if (
      !bypassKeywordFilter &&
      PRIVILEGED_KEYWORDS_RE.test(rawText) &&
      !hasDirectRecipientAddress(sourceText, criteria)
    )
      return false;

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
    const loweredCriteria = criteria.map((c) => c.toLowerCase());
    const sheetCells = readSpreadsheetCells(buffer, wb);
    const exclusionText: string[] = [];

    for (const sheetName of wb.SheetNames) {
      const cells = sheetCells.get(sheetName) || [];
      exclusionText.push(...cells.map((cell) => cell.value));
    }

    const workbookText = exclusionText.join(" ");
    if (
      !bypassKeywordFilter &&
      PRIVILEGED_KEYWORDS_RE.test(workbookText) &&
      !hasDirectRecipientAddress(workbookText, criteria)
    )
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
      const cells = sheetCells.get(sheetName) || [];
      if (cells.length === 0) continue;

      const rows = new Map<number, Map<number, string>>();
      const activeColumns = new Set<number>();
      for (const cell of cells) {
        const row = rows.get(cell.row) || new Map<number, string>();
        row.set(cell.column, cell.value);
        rows.set(cell.row, row);
        activeColumns.add(cell.column);
      }
      const rowNumbers = [...rows.keys()].sort((left, right) => left - right);
      const columns = [...activeColumns].sort((left, right) => left - right);
      const headerRowNumber = rowNumbers[0];
      if (headerRowNumber === undefined || columns.length === 0) continue;
      const headerRow = rows.get(headerRowNumber) || new Map<number, string>();
      const matchedRows = rowNumbers
        .filter((rowNumber) => rowNumber !== headerRowNumber)
        .map((rowNumber) => rows.get(rowNumber) || new Map<number, string>())
        .filter((row) =>
          loweredCriteria.length === 0
            ? true
            : [...row.values()].some((cell) =>
                loweredCriteria.some((criterion) =>
                  cell.toLowerCase().includes(criterion),
                ),
              ),
        );

      if (matchedRows.length > 0) {
        foundMatches = true;
        const normalizedHeaders = columns.map((column) => {
          const raw = headerRow.get(column)?.trim() || "";
          return raw.length > 0 ? raw : `Column ${toExcelColumnLabel(column)}`;
        });
        const normalizedRows = matchedRows.map((row) =>
          columns.map((column, colIdx) => {
            const value = row.get(column) || "";
            return isHtmlBodyColumn(normalizedHeaders[colIdx])
              ? normalizeHtmlSpreadsheetBody(value)
              : value;
          }),
        );

        const sheetColumns = sheet["!cols"] || [];
        const columnUnits = normalizedHeaders.map((header, colIdx) => {
          const sourceColumn = columns[colIdx];
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
          const firstCol = toExcelColumnLabel(columns[pageColumns[0]]);
          const lastCol = toExcelColumnLabel(
            columns[pageColumns[pageColumns.length - 1]],
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
      case_request: { select: { case: { select: { case_type: true } } } },
    },
  });

  if (!row?.filepath) throw new Error(`File ID not found: ${fileId}`);
  const isClientCase = row.case_request?.case.case_type === "client";

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  let relativeSystemPath = path.relative(stagingPath, row.filepath);
  if (
    relativeSystemPath.startsWith("..") ||
    path.isAbsolute(relativeSystemPath)
  )
    relativeSystemPath = fileId;

  const sourceParts = relativeSystemPath.split(/[\\/]/).filter(Boolean);
  // Deliverables are scoped to the request, never to an eDiscovery export
  // subfolder. Every PST under [case]/[request] therefore writes to the one
  // consolidated [case]/[request]/Emails folder.
  let deliverableRelativePath =
    sourceParts.length >= 2
      ? path.join(sourceParts[0], sourceParts[1])
      : path.dirname(relativeSystemPath);
  if (deliverableRelativePath === "." || deliverableRelativePath === "") {
    deliverableRelativePath = path.parse(relativeSystemPath).name;
  }
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

    const padLength = String(Math.max(1, emlFiles.length)).length;
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

    const finalizeAttachmentNames = (
      outputDir: string,
      currentBaseName: string,
    ) => {
      const escapedBase = currentBaseName.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const attachmentPattern = new RegExp(
        `^${escapedBase} Attachment (\\d+)(\\.[^.]+)$`,
      );
      const attachments = fs
        .readdirSync(outputDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map((entry) => ({
          name: entry.name,
          match: entry.name.match(attachmentPattern),
        }))
        .filter(
          (item): item is { name: string; match: RegExpMatchArray } =>
            item.match !== null,
        )
        .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
      if (attachments.length === 0) return;

      const width = String(attachments.length).length;
      const staged = attachments.map(({ name, match }, index) => ({
        from: name,
        to: `${currentBaseName} Attachment ${String(index + 1).padStart(width, "0")}${match[2]}`,
        temporary: `.__aida-attachment-${crypto.randomUUID()}`,
      }));
      if (staged.every((item) => item.from === item.to)) return;
      for (const item of staged) {
        fs.renameSync(
          path.join(outputDir, item.from),
          path.join(outputDir, item.temporary),
        );
      }
      for (const item of staged) {
        fs.renameSync(
          path.join(outputDir, item.temporary),
          path.join(outputDir, item.to),
        );
      }
    };

    // Shared attachment renderer — used for both normal and warning emails.
    const renderNestedAttachments = async (
      attachments: Attachment[],
      currentBaseName: string,
      outputDir: string,
      bypassKeywordFilter = false,
    ) => {
      let attachmentCounter = 1;
      const padLen = String(Math.max(1, attachments.length)).length;

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
      finalizeAttachmentNames(outputDir, currentBaseName);
    };

    for (let idx = 0; idx < emlFiles.length; idx++) {
      const filename = emlFiles[idx];
      const emlPath = path.join(selectedDir, filename);
      const baseName = `Email ${String(idx + 1).padStart(padLength, "0")}`;
      const emailPdfPath = path.join(deliverablesDir, `${baseName}.pdf`);
      let rendered = false;

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
              isClientCase ||
              (subjectPersonalEmail.length > 0 &&
                toValues.includes(subjectPersonalEmail));
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

            rendered =
              fs.existsSync(emailPdfPath) && fs.statSync(emailPdfPath).size > 0;
          })(),
          PER_EMAIL_TIMEOUT_MS,
          `Email render (${filename})`,
        );
      } catch (err) {
        console.error(
          `Skipping ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // The selected EML is the source for this one deliverable. Once its PDF
      // has been verified and its attachment pass finished, reclaim it now so
      // a long Render phase does not hold every original until the last email.
      if (rendered) {
        try {
          fs.rmSync(emlPath, { force: true });
        } catch (error) {
          console.warn(`[Converter] Could not reclaim ${filename}:`, error);
        }
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
      const warnPad = String(Math.max(1, warningRecords.length)).length;

      for (let wi = 0; wi < warningRecords.length; wi++) {
        const { email_hash } = warningRecords[wi];
        const emlPath = path.join(rawEmailsDir, `${email_hash}.eml`);
        if (!fs.existsSync(emlPath)) continue;

        const baseName = `Warning ${String(wi + 1).padStart(warnPad, "0")}`;
        const pdfPath = path.join(warningDir, `${baseName}.pdf`);
        let rendered = false;

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

              rendered =
                fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0;
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

        if (rendered) {
          try {
            fs.rmSync(emlPath, { force: true });
          } catch (error) {
            console.warn(
              `[Converter] Could not reclaim warning email ${email_hash}:`,
              error,
            );
          }
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
          ...(isClientCase
            ? {
                upload_status: "idle",
                upload_total: 0,
                upload_uploaded: 0,
                upload_error: null,
              }
            : {}),
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
    // Attachments and warning mail can create additional nested deliverables.
    // Queue the final sweep without holding the Render phase open for upload.
    const finalized = fs
      .readdirSync(deliverablesDir, { recursive: true })
      .map((entry) => path.join(deliverablesDir, String(entry)))
      .filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile());
    if (!isClientCase) {
      try {
        const queued = await queueSharePointArtifacts(fileId, finalized);
        if (queued > 0) startSharePointArtifactWorker();
      } catch (error) {
        console.error(
          "[Converter] Could not queue final SharePoint artifacts:",
          error,
        );
      }
    }
    await archiveCompletedCase(fileId);
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
