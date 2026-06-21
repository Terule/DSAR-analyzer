import fs from "node:fs";
import path from "node:path";
import { type ParsedMail, simpleParser } from "mailparser";
import puppeteer from "puppeteer";
import { db } from "./db";

function generateEmailHtml(parsedEmail: ParsedMail): string {
  const getAddressText = (
    addr: ParsedMail["from"] | ParsedMail["to"],
  ): string => {
    if (!addr) return "Unknown";
    if (Array.isArray(addr)) return addr.map((a) => a.text).join(", ");
    return addr.text || "Unknown";
  };

  const from = getAddressText(parsedEmail.from);
  const to = getAddressText(parsedEmail.to);
  const subject = parsedEmail.subject || "(No Subject)";
  const date = parsedEmail.date
    ? new Date(parsedEmail.date).toLocaleString()
    : "Unknown Date";

  let bodyContent =
    parsedEmail.html ||
    (parsedEmail.text
      ? `<pre style="white-space: pre-wrap; font-family: sans-serif;">${parsedEmail.text}</pre>`
      : "<em>(No body content)</em>");

  if (parsedEmail.attachments && parsedEmail.attachments.length > 0) {
    parsedEmail.attachments.forEach((att) => {
      if (att.contentId && att.content) {
        const cid = att.contentId.replace(/[<>]/g, "");
        const base64 = att.content.toString("base64");
        const mimeType = att.contentType || "image/jpeg";
        const dataUri = `data:${mimeType};base64,${base64}`;
        const cidRegex = new RegExp(`cid:${cid}`, "gi");
        bodyContent = bodyContent.replace(cidRegex, dataUri);
      }
    });
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: sans-serif; line-height: 1.5; color: #333; margin: 0; padding: 20px; }
        .header { border-bottom: 2px solid #eee; padding-bottom: 15px; margin-bottom: 20px; }
        .header-row { margin-bottom: 5px; }
        .label { font-weight: bold; color: #555; margin-right: 5px; }
        .subject { font-size: 1.2em; font-weight: bold; margin-top: 10px; }
        .body-container { overflow-wrap: break-word; }
        img { max-width: 100%; height: auto; }
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
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
  if (!row) throw new Error(`File ID not found: ${fileId}`);

  db.prepare(
    "UPDATE processed_files SET pdf_status = 'processing' WHERE id = ?",
  ).run(fileId);

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

  const targetFolder = path.join(outputBaseDir, cleanRelativePath);
  const exportDir = path.join(targetFolder, "export");

  if (!fs.existsSync(exportDir)) {
    db.prepare(
      "UPDATE processed_files SET pdf_status = 'failed' WHERE id = ?",
    ).run(fileId);
    return;
  }

  let browser = null;

  (async () => {
    try {
      browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();

      const emlFiles = fs
        .readdirSync(exportDir)
        .filter((f) => f.endsWith(".eml"));

      for (const filename of emlFiles) {
        const emlPath = path.join(exportDir, filename);
        const pdfPath = path.join(
          exportDir,
          filename.replace(/\.eml$/i, ".pdf"),
        );

        if (fs.existsSync(pdfPath)) continue;

        try {
          const rawEml = fs.readFileSync(emlPath);
          const parsed = await simpleParser(rawEml);
          const htmlContent = generateEmailHtml(parsed);

          await page.setContent(htmlContent, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });

          await page.pdf({
            path: pdfPath,
            format: "A4",
            margin: {
              top: "20mm",
              bottom: "20mm",
              left: "20mm",
              right: "20mm",
            },
            printBackground: true,
          });

          fs.unlinkSync(emlPath);
        } catch (err) {
          console.error(`Failed to convert ${filename} to PDF:`, err);
        }
      }

      const parentFiles = fs.readdirSync(targetFolder);
      for (const file of parentFiles) {
        const fullPath = path.join(targetFolder, file);
        if (fs.statSync(fullPath).isFile()) {
          // Remove EML, JSON and raw extracted files to keep root targetFolder absolutely spotless!
          if (
            file.endsWith(".eml") ||
            file.endsWith(".json") ||
            file.includes("Attachment")
          ) {
            fs.unlinkSync(fullPath);
          }
        }
      }

      db.prepare(
        "UPDATE processed_files SET pdf_status = 'completed' WHERE id = ?",
      ).run(fileId);
    } catch (error) {
      console.error(
        `Fatal error in PDF conversion engine for ${fileId}:`,
        error,
      );
      db.prepare(
        "UPDATE processed_files SET pdf_status = 'failed' WHERE id = ?",
      ).run(fileId);
    } finally {
      if (browser) await browser.close();
    }
  })().catch((err) =>
    console.error("Unhandled background PDF thread error:", err),
  );
}
