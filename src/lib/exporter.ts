import fs from "node:fs";
import path from "node:path";
import { type AddressObject, simpleParser } from "mailparser";
import { stripEmailSignature } from "./email-content";
import { prisma } from "./prisma";
import { getPstArtifactPaths } from "./pst-artifacts";

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

function extractHeaderValue(block: string, header: string): string {
  const match = block.match(new RegExp(`^${header}:\\s*(.*)$`, "im"));
  return (match?.[1] || "").trim();
}

const THREAD_BOUNDARY_RE =
  /(?:\r?\n)(?=From:\s|On .*wrote:|_{10,}|-----Original Message-----|\s*>)/i;

function extractVisibleBody(block: string): string {
  const markers = [
    /\r?\nOn .*wrote:/i,
    /\r?\nFrom:\s/i,
    /\r?\n_{10,}/i,
    /\r?\n-----Original Message-----/i,
    /\r?\n\s*>/,
  ];

  let cutIndex = block.length;

  for (const marker of markers) {
    const matchIndex = block.search(marker);
    if (matchIndex !== -1) {
      cutIndex = Math.min(cutIndex, matchIndex);
    }
  }

  return block.slice(0, cutIndex).trim();
}

function stripQuotedHeaders(block: string): string {
  return block
    .replace(/^(from|to|cc|bcc|subject|date|sent):.*$/gim, "")
    .replace(/^(-----Original Message-----|_{8,}).*$/gim, "")
    .trim();
}

function splitThread(rawBody: string) {
  const blocks = rawBody
    .split(THREAD_BOUNDARY_RE)
    .map((b) => b.trim())
    .filter(Boolean);

  const firstBlock = blocks[0] || rawBody;
  const secondBlock = blocks[1] || "";
  const restBlocks = blocks.slice(2);

  return {
    firstBlock,
    secondBlock,
    restText: restBlocks.join("\n\n"),
  };
}

export async function extractUniqueEmails(
  fileId: string,
  outputBaseDir: string = process.env.EXTRACTED_PATH ||
    "/Users/rgomes/Projects/extracted_emails",
) {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { filepath: true },
  });
  if (!row?.filepath) throw new Error("File target missing");

  await prisma.processedFile.update({
    where: { id: fileId },
    data: { status: "extracting", estimated_tokens: 0 },
  });

  try {
    const stagingPath =
      process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";

    const { caseFolder: mainFolder, rawEmlFolder: rawFolder } =
      getPstArtifactPaths({
        fileId,
        filepath: row.filepath,
        stagingPath,
        extractedPath: outputBaseDir,
      });

    const uniqueEmailsFolder = path.join(mainFolder, ".unique-emails");
    const uniqueRawEmailsFolder = path.join(uniqueEmailsFolder, "raw-emails");
    const uniqueJsonFolder = path.join(uniqueEmailsFolder, "json-files");
    const selectedFolder = path.join(uniqueEmailsFolder, "selected");
    const discardedFolder = path.join(uniqueEmailsFolder, "discarded");

    fs.mkdirSync(uniqueRawEmailsFolder, { recursive: true });
    fs.mkdirSync(uniqueJsonFolder, { recursive: true });
    fs.mkdirSync(selectedFolder, { recursive: true });
    fs.mkdirSync(discardedFolder, { recursive: true });

    console.log(
      `[Extraction Debug] Looking for secure file-specific raw folder at: ${rawFolder}`,
    );

    if (!fs.existsSync(rawFolder)) {
      throw new Error(
        `Raw EML folder missing at ${rawFolder}. Run analysis first.`,
      );
    }

    const uniqueRecords = await prisma.email.findMany({
      where: { file_id: fileId, is_duplicate: 0 },
      select: { id: true, email_hash: true },
    });

    let totalTokens = 0;
    let draftsBlocked = 0;

    for (const record of uniqueRecords) {
      const emlPath = path.join(rawFolder, `${record.id}.eml`);
      const jsonPath = path.join(uniqueJsonFolder, `${record.email_hash}.json`);
      const finalEmlPath = path.join(
        uniqueRawEmailsFolder,
        `${record.email_hash}.eml`,
      );

      if (fs.existsSync(emlPath)) {
        // Normalization hands the EML to the case-level raw folder. It is a
        // move so a large PST email is never retained twice between stages.
        fs.renameSync(emlPath, finalEmlPath);

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
          await prisma.email.update({
            where: { id: record.id },
            data: {
              ai_decision: "discard",
              ai_reason: "System Discard: Draft (Missing Routing Headers)",
            },
          });

          // 2. Delete the copied .eml file so it doesn't clutter the main folder
          fs.unlinkSync(finalEmlPath);

          draftsBlocked++;
          continue; // Skip the rest of the loop (no JSON generation!)
        }

        const fallbackText = sanitizeEmailBody(
          parsed.text || "",
          parsed.html || "",
        );

        const threadBlocks = fallbackText.split(THREAD_BOUNDARY_RE);
        let aiBodyText = fallbackText;
        if (threadBlocks.length > 2) {
          aiBodyText = threadBlocks.slice(0, 2).join("\n");
        }

        const subject = parsed.subject || "no-subject";
        const date = parsed.date ? parsed.date.toISOString() : "no-date";

        const { firstBlock, secondBlock, restText } = splitThread(aiBodyText);

        const firstEmail = {
          date,
          from: fromFormatted,
          to: toFormatted,
          subject,
          body: stripEmailSignature(
            extractVisibleBody(stripQuotedHeaders(firstBlock)),
          ).substring(0, 12000),
        };

        const secondEmail = secondBlock
          ? {
              from: extractHeaderValue(secondBlock, "From") || "Unknown",
              to: extractHeaderValue(secondBlock, "To") || "Unknown",
              subject:
                extractHeaderValue(secondBlock, "Subject") || "(No Subject)",
              body: stripEmailSignature(
                extractVisibleBody(stripQuotedHeaders(secondBlock)),
              ).substring(0, 6000),
            }
          : null;

        const attachments = (parsed.attachments || []).map((att) => ({
          filename: att.filename || "unknown",
          content_type: att.contentType || "unknown",
          size_bytes: att.size || 0,
        }));

        const aiPayload = {
          meta: {
            source_file: `${record.email_hash}.eml`,
            attachment_count: attachments.length,
            to_recipient_count: toRaw
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean).length,
          },
          first_email: firstEmail,
          second_email: secondEmail,
          rest_of_chain: {
            text: stripEmailSignature(restText).substring(0, 10000),
          },
          attachments,
        };

        const serializedPayload = JSON.stringify(aiPayload, null, 2);
        fs.writeFileSync(jsonPath, serializedPayload);

        totalTokens += estimateTokens(serializedPayload);
      }
    }

    // Safe cleanup: remove per-PST extraction staging folder after normalization
    fs.rmSync(rawFolder, { recursive: true, force: true });

    // Update total discarded counter instantly with our blocked drafts
    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        status: "completed",
        estimated_tokens: totalTokens,
        ai_discarded_count: { increment: draftsBlocked },
      },
    });
  } catch (error) {
    console.error("Extraction failed:", error);
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { status: "failed" },
    });
    throw error;
  }
}
