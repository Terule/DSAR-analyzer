import fs from "node:fs";
import path from "node:path";
import { type AddressObject, simpleParser } from "mailparser";
import { db } from "./db";

// Helper to calculate basic token estimates
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function cleanExchangeDN(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "") return "No Recipient";
  if (raw.includes("/O=EXCHANGELABS") || raw.includes("/CN=")) {
    const parts = raw.split("-");
    if (parts.length > 1) return parts[parts.length - 1].toLowerCase();
    return "Exchange Internal User";
  }
  return raw;
}

// Aggressively strip Outlook CSS/VML artifacts and condense whitespace
function sanitizeEmailBody(rawBody: string, htmlBody: string): string {
  let textToClean = rawBody;
  if (!textToClean && htmlBody) {
    textToClean = htmlBody
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>?/gm, "");
  }
  if (!textToClean) return "";
  return textToClean
    .replace(/v\\:\* \{[^}]+\}/g, "")
    .replace(/o\\:\* \{[^}]+\}/g, "")
    .replace(/w\\:\* \{[^}]+\}/g, "")
    .replace(/\.shape\s*\{[^}]+\}/g, "")
    .replace(/MicrosoftInternetExplorer4/g, "")
    .replace(/<!--\[if [^\]]+\]>[\s\S]*?<!\[endif\]-->/g, "")
    .replace(/(\r?\n|\r){2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Helper to safely extract text from mailparser's AddressObject | AddressObject[]
function getAddressText(
  addr: AddressObject | AddressObject[] | undefined,
): string {
  if (!addr) return "";
  if (Array.isArray(addr)) return addr.map((a) => a.text).join(", ");
  return addr.text || "";
}

export async function extractUniqueEmails(
  fileId: string,
  outputBaseDir: string = process.env.EXTRACTED_PATH ||
    "/Users/rgomes/Projects/extracted_emails",
) {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
  if (!row) throw new Error("File target missing");

  db.prepare(
    "UPDATE processed_files SET status = 'extracting', estimated_tokens = 0 WHERE id = ?",
  ).run(fileId);

  try {
    const stagingPath =
      process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";

    let cleanRelativePath = "";
    if (row.filepath.startsWith(stagingPath)) {
      const rel = path.relative(stagingPath, row.filepath);
      cleanRelativePath = path.dirname(rel);
    } else {
      cleanRelativePath = fileId;
    }

    if (cleanRelativePath === "." || cleanRelativePath === "") {
      cleanRelativePath = path.parse(row.filepath).name;
    }

    const mainFolder = path.join(outputBaseDir, cleanRelativePath);
    const rawFolder = path.join(mainFolder, `.raw_${fileId}`);

    console.log(
      `[Extraction Debug] Looking for secure file-specific raw folder at: ${rawFolder}`,
    );

    if (!fs.existsSync(rawFolder)) {
      throw new Error(
        `Raw EML folder missing at ${rawFolder}. Run analysis first.`,
      );
    }

    const uniqueRecords = db
      .prepare(
        "SELECT id, email_hash FROM emails WHERE file_id = ? AND is_duplicate = 0",
      )
      .all(fileId) as { id: string; email_hash: string }[];

    let totalTokens = 0;
    let draftsBlocked = 0;

    for (const record of uniqueRecords) {
      const emlPath = path.join(rawFolder, `${record.id}.eml`);
      const jsonPath = path.join(mainFolder, `${record.email_hash}.json`);
      const finalEmlPath = path.join(mainFolder, `${record.email_hash}.eml`);

      if (fs.existsSync(emlPath)) {
        fs.copyFileSync(emlPath, finalEmlPath);
        fs.unlinkSync(emlPath);

        const rawEml = fs.readFileSync(finalEmlPath);
        const parsed = await simpleParser(rawEml);

        const fromRaw = getAddressText(parsed.from);
        const toRaw = getAddressText(parsed.to);

        const fromFormatted = cleanExchangeDN(fromRaw);
        const toFormatted = cleanExchangeDN(toRaw);

        // 🚨 DRAFT INTERCEPTOR: Block it before generating JSON payload for the AI
        if (
          !fromRaw ||
          !toRaw ||
          fromFormatted === "No Recipient" ||
          toFormatted === "No Recipient"
        ) {
          // 1. Mark as discarded in DB so the AI step ignores it
          db.prepare(
            "UPDATE emails SET ai_decision = 'discard', ai_reason = 'System Discard: Draft (Missing Routing Headers)' WHERE id = ?",
          ).run(record.id);

          // 2. Delete the copied .eml file so it doesn't clutter the main folder
          fs.unlinkSync(finalEmlPath);

          draftsBlocked++;
          continue; // Skip the rest of the loop (no JSON generation!)
        }

        const fallbackText = sanitizeEmailBody(
          parsed.text || "",
          parsed.html || "",
        );

        const threadBlocks = fallbackText.split(
          /(?:\r?\n)(?=From:\s|_{10,}|-----Original Message-----)/i,
        );
        let aiBodyText = fallbackText;
        if (threadBlocks.length > 2) {
          aiBodyText = threadBlocks.slice(0, 2).join("\n");
        }

        const subject = parsed.subject || "no-subject";
        const date = parsed.date ? parsed.date.toISOString() : "no-date";

        const aiTextPayload = `Date: ${date}\nFrom: ${fromFormatted}\nTo: ${toFormatted}\nSubject: ${subject}\n\n${aiBodyText.substring(0, 15000)}`;

        fs.writeFileSync(
          jsonPath,
          JSON.stringify({ text: aiTextPayload }, null, 2),
        );

        totalTokens += estimateTokens(aiTextPayload);
      }
    }

    // Safe Cleanup: Strictly delete ONLY this specific file's raw folder
    fs.rmSync(rawFolder, { recursive: true, force: true });

    // Update total discarded counter instantly with our blocked drafts
    db.prepare(`
        UPDATE processed_files 
        SET status = 'completed', estimated_tokens = ?, ai_discarded_count = ai_discarded_count + ? 
        WHERE id = ?
      `).run(totalTokens, draftsBlocked, fileId);
  } catch (error) {
    console.error("Extraction failed:", error);
    db.prepare("UPDATE processed_files SET status = 'failed' WHERE id = ?").run(
      fileId,
    );
    throw error;
  }
}
