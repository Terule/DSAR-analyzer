/**
 * How a delivered file is attached to a OneTrust request: the v2 Results Summary
 * endpoint. The v3 endpoint documents a per-attachment `isRedact`, but on our
 * tenant it rejects every request that carries `attachments` with
 * ERROR_DATASUBJECT-ACCESS_INVALID_DATA (tested 2026-11-20 with and without
 * `isRedact`, `results` and email metadata), while v2 accepts them. Do not
 * switch back to v3 without testing it on a request first.
 */
export function resultSummaryPath(requestId: string): string {
  return `/api/datasubject/v2/datadiscovery/requestqueues/${encodeURIComponent(requestId)}`;
}

export function resultSummaryBody(
  system: string,
  attachmentName: string,
  fileId: string,
  metadata?: EmailAttachmentMetadata,
) {
  return {
    system,
    // The Results Summary API requires the dataset container even when this
    // integration contributes only document attachments.
    results: {},
    attachments: [
      {
        fileName: attachmentName,
        fileId,
        ...(metadata ? { emlAttachmentMetadata: metadata } : {}),
      },
    ],
  };
}

export interface EmailAttachmentMetadata {
  emlSubject?: string;
  sendDate?: string;
}

/** What OneTrust shows next to an email PDF: its subject and when it was sent. */
export function emailMetadata(
  subject: string | null | undefined,
  sentDate: string | null | undefined,
): EmailAttachmentMetadata | undefined {
  const emlSubject = (subject ?? "").trim();
  const parsed = sentDate ? new Date(sentDate) : null;
  const sendDate =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "";
  if (!emlSubject && !sendDate) return undefined;
  return {
    ...(emlSubject ? { emlSubject } : {}),
    ...(sendDate ? { sendDate } : {}),
  };
}

/** `Email 0412.pdf` (top level of Emails/) -> 412; anything else -> null. */
export function emailNumberFromPath(relativePath: string): number | null {
  const match = /^Emails[\\/]Email (\d+)\.pdf$/.exec(relativePath);
  return match ? Number(match[1]) : null;
}

/** Number -> email hash, from the render ledger lines (`{h, n}`). */
export function ledgerHashesByNumber(text: string): Map<number, string> {
  const byNumber = new Map<number, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { h?: unknown; n?: unknown };
      if (typeof entry.h === "string" && typeof entry.n === "number") {
        byNumber.set(entry.n, entry.h);
      }
    } catch {
      // a half-written last line
    }
  }
  return byNumber;
}

/** Seconds OneTrust asks us to wait, bounded; falls back to a growing delay. */
export function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
): number {
  const seconds = Number(retryAfter);
  const base =
    Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : Math.min(30_000, 2_000 * 2 ** attempt);
  return Math.min(120_000, base);
}

export const MAX_RATE_LIMIT_RETRIES = 5;

/** File ids already attached to a request, from the group read-back pages. */
export function attachedFileIds(
  groups: Array<{
    dataDiscoveryAttachmentListDtos?: Array<{ fileId?: string }>;
  }>,
): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const attachment of group.dataDiscoveryAttachmentListDtos ?? []) {
      if (attachment.fileId) ids.add(attachment.fileId);
    }
  }
  return ids;
}
