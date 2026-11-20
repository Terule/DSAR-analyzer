import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { simpleParser } from "mailparser";
import mammoth from "mammoth";
import * as xlsx from "xlsx";
import { getCasePstFileIds, markCaseAiCompleted } from "./case-utils";
import { flattenAttachments } from "./email-attachments";
import { decideEmail } from "./email-decisions";
import {
  type FilesAiClient,
  isFilesAiSettled,
  isMailItem,
  MAIL_ITEM_PREFIX,
  prepareFilesAi,
  sendItemsToReview,
} from "./files-ai";
import { type FilesAiCandidate, readPdfSample } from "./files-ai-extract";
import { configuredFilesAiClient } from "./files-ai-provider";
import { getAiBatchSettings } from "./pipeline-settings";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";

/**
 * Between the email audit and Render, the case's coordinator screens what the
 * audit never read for confidential content: every attachment of the emails
 * about to be rendered and, in client cases (which have no email audit), the
 * email bodies. Judgements reuse the Files AI batches and verdict table, keyed
 * `mail:<content hash>` for attachments and `mail:body:<email hash>` for bodies.
 * Render then only consults the verdicts, so nothing confidential is rendered
 * and the numbering stays contiguous.
 */

const BODY_PREFIX = `${MAIL_ITEM_PREFIX}body:`;
// A workbook this large cannot be parsed safely in the worker process; it is
// treated as unreadable and goes to a person.
const MAX_PARSE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const CHARS_PER_PAGE = 3_000;

export interface MailScreenVerdict {
  verdict: "keep" | "discard" | "review";
  reason: string;
}

export function attachmentKey(content: Uint8Array): string {
  return `${MAIL_ITEM_PREFIX}${crypto
    .createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 24)}`;
}

export const bodyKey = (emailHash: string) => `${BODY_PREFIX}${emailHash}`;

export interface MailFolders {
  selected: string;
  rawEmails: string;
  discarded: string;
  review: string;
  screen: string;
}

async function coordinatorInfo(fileId: string) {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: {
      filepath: true,
      ai_started_at: true,
      case_request: { select: { case: { select: { case_type: true } } } },
    },
  });
  if (!row?.filepath) return null;
  const unique = path.join(
    getPstWorkFolder({
      fileId,
      filepath: row.filepath,
      stagingPath: process.env.STAGING_PATH || "",
      extractedPath: process.env.EXTRACTED_PATH || "",
    }),
    ".unique-emails",
  );
  const folders: MailFolders = {
    selected: path.join(unique, "selected"),
    rawEmails: path.join(unique, "raw-emails"),
    discarded: path.join(unique, "discarded"),
    review: path.join(unique, "review"),
    screen: path.join(unique, "screen"),
  };
  return {
    folders,
    isClient: row.case_request?.case.case_type === "client",
    aiStartedAt:
      typeof row.ai_started_at === "bigint" ? Number(row.ai_started_at) : null,
  };
}

/** Text of one screened item plus a page estimate (for the large-file rule). */
export async function readMailItem(
  absPath: string,
): Promise<{ text: string; totalPages: number }> {
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (fs.statSync(absPath).size > MAX_PARSE_BYTES) {
      return { text: "", totalPages: 0 };
    }
    if (ext === ".pdf") return await readPdfSample(absPath);
    let text = "";
    if (ext === ".txt") {
      text = fs.readFileSync(absPath, "utf8");
    } else if (ext === ".docx" || ext === ".doc") {
      text = (await mammoth.extractRawText({ path: absPath })).value || "";
    } else if ([".xlsx", ".xls", ".csv"].includes(ext)) {
      const book = xlsx.readFile(absPath, { cellText: true });
      text = book.SheetNames.map(
        (name) => `# ${name}\n${xlsx.utils.sheet_to_csv(book.Sheets[name])}`,
      ).join("\n");
    }
    text = text.slice(0, MAX_TEXT_CHARS).trim();
    return { text, totalPages: Math.ceil(text.length / CHARS_PER_PAGE) };
  } catch {
    return { text: "", totalPages: 0 };
  }
}

/**
 * Writes every item to screen under `folders.screen` and lists them. Duplicate
 * attachments (the same file mailed a thousand times) are judged once.
 */
export async function gatherMailItems(input: {
  fileId: string;
  isClient: boolean;
  folders: MailFolders;
}): Promise<FilesAiCandidate[]> {
  const { folders } = input;
  fs.rmSync(folders.screen, { recursive: true, force: true });
  fs.mkdirSync(folders.screen, { recursive: true });

  const sources: Array<{ hash: string; file: string; body: boolean }> = [];
  if (fs.existsSync(folders.selected)) {
    for (const name of fs.readdirSync(folders.selected)) {
      if (!name.endsWith(".eml")) continue;
      sources.push({
        hash: name.slice(0, -4),
        file: path.join(folders.selected, name),
        body: input.isClient,
      });
    }
  }
  // Self-forwards are rendered with their attachments too (employee cases).
  if (!input.isClient) {
    const warnings = await prisma.email.findMany({
      where: {
        file_id: { in: await getCasePstFileIds(input.fileId) },
        ai_decision: "warning",
        is_duplicate: 0,
      },
      select: { email_hash: true },
    });
    for (const { email_hash } of warnings) {
      const file = path.join(folders.rawEmails, `${email_hash}.eml`);
      if (fs.existsSync(file))
        sources.push({ hash: email_hash, file, body: false });
    }
  }

  const items: FilesAiCandidate[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    let parsed: Awaited<ReturnType<typeof simpleParser>>;
    try {
      parsed = await simpleParser(fs.readFileSync(source.file));
    } catch {
      continue;
    }
    if (source.body) {
      const key = bodyKey(source.hash);
      const absPath = path.join(folders.screen, `body-${source.hash}.txt`);
      fs.writeFileSync(
        absPath,
        `Subject: ${parsed.subject ?? ""}\n\n${parsed.text ?? ""}`,
      );
      items.push({
        relPath: key,
        kind: "Message",
        fileName: `Email body ${source.hash.slice(0, 8)}`,
        absPath,
      });
    }
    const files = await flattenAttachments(parsed.attachments ?? []);
    for (const file of files) {
      const key = attachmentKey(file.content);
      if (seen.has(key)) continue;
      seen.add(key);
      const absPath = path.join(
        folders.screen,
        `${key.slice(MAIL_ITEM_PREFIX.length)}${path.extname(file.filename).toLowerCase()}`,
      );
      fs.writeFileSync(absPath, file.content);
      items.push({
        relPath: key,
        kind: "Document",
        fileName: file.filename,
        absPath,
      });
    }
  }
  return items;
}

/** Submits the screening batches. Never throws: anything unjudged goes to a person. */
async function submitScreen(
  fileId: string,
  items: FilesAiCandidate[],
  injected?: FilesAiClient | null,
): Promise<void> {
  const client =
    injected === undefined
      ? await configuredFilesAiClient().catch(() => null)
      : injected;
  if (!client) {
    await sendItemsToReview(
      fileId,
      items,
      "No AI screening available; needs human review.",
    );
    return;
  }
  try {
    await prepareFilesAi({
      fileId,
      dirs: { messagesDir: "", documentsDir: "" },
      criteria: { name: "", email: "", aliases: [] },
      client,
      mode: "mail",
      candidates: items,
      readSample: readMailItem,
    });
  } catch (error) {
    console.warn(`[Mail Screen] submit failed for ${fileId}: ${error}`);
    await prisma.filesAiVerdict.updateMany({
      where: { file_id: fileId, verdict: null, batch_run_id: null },
      data: {
        verdict: "review",
        reason: "AI step failed; needs human review.",
        resolved_at: new Date(),
      },
    });
  }
}

export type MailScreenStart = "disabled" | "completed" | "screening";

/**
 * Called where the case's AI phase would complete. Starts the screening and
 * returns "screening" (the coordinator stays `batch_ready` until it finishes),
 * or completes the AI phase itself when there is nothing to screen.
 */
export async function startMailScreen(
  coordinatorId: string,
  elapsedMs: number,
  /** `undefined` opens the real client; `null` means no AWS credentials. Tests inject. */
  client?: FilesAiClient | null,
): Promise<MailScreenStart> {
  if (!(await getAiBatchSettings()).filesAiEnabled) {
    await markCaseAiCompleted(coordinatorId, elapsedMs);
    return "disabled";
  }
  const info = await coordinatorInfo(coordinatorId);
  if (!info) {
    await markCaseAiCompleted(coordinatorId, elapsedMs);
    return "disabled";
  }
  // "preparing" holds Render back (ai_status stays batch_ready) while the items
  // are read and submitted, which takes seconds. `settleMailScreens` only looks
  // at "screening", so it cannot mistake the not-yet-written items for "all
  // judged" and release Render before anything was screened.
  await prisma.processedFile.update({
    where: { id: coordinatorId },
    data: {
      mail_screen_status: "preparing",
      ai_status: "batch_ready",
      ai_duration_ms: elapsedMs,
    },
  });
  try {
    const items = await gatherMailItems({
      fileId: coordinatorId,
      isClient: info.isClient,
      folders: info.folders,
    });
    if (items.length > 0) await submitScreen(coordinatorId, items, client);
  } catch (error) {
    console.warn(`[Mail Screen] could not gather items: ${error}`);
    await prisma.filesAiVerdict.updateMany({
      where: { file_id: coordinatorId, verdict: null, batch_run_id: null },
      data: {
        verdict: "review",
        reason: "AI step failed; needs human review.",
        resolved_at: new Date(),
      },
    });
  }
  // Items and batch runs are now durable: from here the poller may settle it.
  await prisma.processedFile.update({
    where: { id: coordinatorId },
    data: { mail_screen_status: "screening" },
  });
  if (await isFilesAiSettled(coordinatorId)) {
    await finishMailScreen(coordinatorId);
    return "completed";
  }
  return "screening";
}

function moveEml(from: string, toFolder: string, hash: string): boolean {
  const source = path.join(from, `${hash}.eml`);
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(toFolder, { recursive: true });
  fs.renameSync(source, path.join(toFolder, `${hash}.eml`));
  return true;
}

/**
 * Applies the body verdicts (client cases) and completes the AI phase so Render
 * can run. Safe to repeat: moves are idempotent and the counters only move for
 * emails still marked `keep`.
 */
export async function finishMailScreen(coordinatorId: string): Promise<void> {
  const info = await coordinatorInfo(coordinatorId);
  if (info) {
    const bodies = await prisma.filesAiVerdict.findMany({
      where: {
        file_id: coordinatorId,
        rel_path: { startsWith: BODY_PREFIX },
        verdict: { in: ["discard", "review"] },
      },
      select: { rel_path: true, verdict: true, reason: true },
    });
    let discarded = 0;
    for (const body of bodies) {
      const hash = body.rel_path.slice(BODY_PREFIX.length);
      const target = body.verdict === "discard" ? "discard" : "review";
      moveEml(
        info.folders.selected,
        target === "discard" ? info.folders.discarded : info.folders.review,
        hash,
      );
      const written = await decideEmail({
        emailHash: hash,
        decision: target,
        rule: "mail_screen",
        reason: body.reason ?? "",
        decidedBy: "bedrock",
        guard: { ai_decision: "keep" },
      });
      if (target === "discard") discarded += written;
    }
    if (discarded > 0) {
      await prisma.processedFile.update({
        where: { id: coordinatorId },
        data: { ai_discarded_count: { increment: discarded } },
      });
    }
  }
  const elapsed = await prisma.processedFile.findUnique({
    where: { id: coordinatorId },
    select: { ai_duration_ms: true },
  });
  await markCaseAiCompleted(
    coordinatorId,
    Number(elapsed?.ai_duration_ms ?? 0),
  );
  await prisma.processedFile.update({
    where: { id: coordinatorId },
    data: { mail_screen_status: "done" },
  });
}

/** Finishes every screening whose batches have all been read. Run by the poller. */
export async function settleMailScreens(): Promise<string[]> {
  const waiting = await prisma.processedFile.findMany({
    where: { mail_screen_status: "screening", ai_status: "batch_ready" },
    select: { id: true },
  });
  const finished: string[] = [];
  for (const { id } of waiting) {
    if (await isFilesAiSettled(id)) {
      await finishMailScreen(id);
      finished.push(id);
    }
  }
  return finished;
}

/**
 * What Render must do with each screened item, or null when the case was not
 * screened (setting off, or an older run), in which case it delivers as before.
 */
export async function getMailScreenVerdicts(
  coordinatorId: string,
): Promise<Map<string, MailScreenVerdict> | null> {
  const row = await prisma.processedFile.findUnique({
    where: { id: coordinatorId },
    select: { mail_screen_status: true },
  });
  if (row?.mail_screen_status !== "done") return null;
  const verdicts = await prisma.filesAiVerdict.findMany({
    where: {
      file_id: coordinatorId,
      rel_path: { startsWith: MAIL_ITEM_PREFIX },
    },
    select: { rel_path: true, verdict: true, reason: true },
  });
  return new Map(
    verdicts.map((v) => [
      v.rel_path,
      {
        verdict: (v.verdict ?? "review") as MailScreenVerdict["verdict"],
        reason: v.reason ?? "",
      },
    ]),
  );
}

export { isMailItem };
