import crypto from "node:crypto";
import path from "node:path";
import { prisma } from "./prisma";

/**
 * Deduplication scope for a PST's emails: `[case]/[request]/PST`. Every PST of
 * a request (and of every wave of it) shares the scope, so the same email in
 * two PST files dedups, while different requests never collide. Paths with
 * fewer than three segments keep the legacy `dirname` scope.
 */
export function dedupScope(sourceRelativePath: string): string {
  const parts = sourceRelativePath.split(/[\\/]/).filter(Boolean);
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}/PST`;
  return path.dirname(sourceRelativePath);
}

/** `email_hash` = sha256(`<scope>::<baseHash>`) hex. */
export function computeEmailHash(scope: string, baseHash: string): string {
  return crypto
    .createHash("sha256")
    .update(`${scope}::${baseHash}`)
    .digest("hex");
}

/**
 * True when the email is already known: the same `email_hash`, or (legacy
 * bridge for requests parsed before the scope fix, whose hashes include the
 * PST filename) the same Message-ID already recorded for this request.
 */
export async function isDuplicateEmail(input: {
  emailHash: string;
  messageId: string;
  caseRequestId: string | null;
}): Promise<boolean> {
  const byHash = await prisma.email.findFirst({
    where: { email_hash: input.emailHash },
    select: { id: true },
  });
  if (byHash) return true;
  if (!input.caseRequestId || input.messageId.length <= 5) return false;
  const byMessageId = await prisma.email.findFirst({
    where: {
      message_id: input.messageId,
      processed_file: { case_request_id: input.caseRequestId },
    },
    select: { id: true },
  });
  return Boolean(byMessageId);
}
