import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";
import puppeteer from "puppeteer";
import { processDocxToPdf, processExcelToPdf } from "@/lib/converter";

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

export async function POST(request: Request) {
  try {
    const { caseName, subjectCriteria } = await request.json();

    if (!caseName || !subjectCriteria?.name) {
      return NextResponse.json(
        { success: false, error: "Missing caseName or subjectCriteria.name" },
        { status: 400 },
      );
    }

    // 1. Build Criteria & Exclusion Arrays
    const aliases = subjectCriteria.aliases || [];
    const criteria = [subjectCriteria.name, ...aliases].map((c) =>
      c.toLowerCase(),
    );
    const exclusions = ["confidential", "privileged", "cro"];

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

    let browser = null;
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

    try {
      // Launch Puppeteer for HTML & Office rendering
      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
      const page = await browser.newPage();

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
        if (ext === ".html" || ext === ".htm") {
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
            page,
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
            page,
            seqName,
            processedHashes,
          );
        }

        // --- HANDLER 3: Teams Chats (HTML) ---
        else if (ext === ".html" || ext === ".htm") {
          const rawHtml = buffer.toString("utf-8");
          const rawText = rawHtml.replace(/<[^>]*>?/gm, "").toLowerCase();

          if (exclusions.some((ex) => rawText.includes(ex))) {
            console.log(
              `[Standalone Filter] Discarded HTML ${file}: Contains excluded keyword.`,
            );
          } else if (!criteria.some((c) => rawText.includes(c))) {
            console.log(
              `[Standalone Filter] Discarded HTML ${file}: Data subject not mentioned.`,
            );
          } else {
            try {
              await page.setContent(rawHtml, {
                waitUntil: "domcontentloaded",
                timeout: 20000,
              });
              await page.pdf({
                path: pdfOutputPath,
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
              success = true;
            } catch (_e) {
              console.warn(
                `[Standalone Filter] Failed to render HTML to PDF: ${file}`,
              );
            }
          }
        }

        // --- HANDLER 4: Raw PDFs ---
        else if (ext === ".pdf") {
          try {
            const parser = new PDFParse({ data: buffer });
            try {
              const pdfData = await parser.getText();
              const rawText = pdfData.text.toLowerCase();

              if (exclusions.some((ex) => rawText.includes(ex))) {
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
            } finally {
              await parser.destroy();
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
          console.log(`[Standalone Engine] ✅ Exported: ${seqName}.pdf`);
        } else {
          skippedCount++;
        }
      }
    } finally {
      if (browser) await browser.close();
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
