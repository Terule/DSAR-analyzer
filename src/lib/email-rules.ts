import type { ParsedMail } from "mailparser";
import { hasPrivilegedKeyword } from "./exclusions";
import { isSentToPersonalAddress } from "./subject-rules";

type AddressField = ParsedMail["to"] | ParsedMail["from"];

/** Lower-cased addresses of a parsed header (From, To, Cc, Bcc). */
export function collectMailAddresses(value: AddressField): string[] {
  if (!value) return [];
  const containers = Array.isArray(value) ? value : [value];
  return containers
    .flatMap((container) => container.value ?? [])
    .map((entry) => (entry.address ?? "").toLowerCase())
    .filter(Boolean);
}

/** To, Cc and Bcc together. */
export function mailRecipients(parsed: ParsedMail): string[] {
  return [
    ...collectMailAddresses(parsed.to),
    ...collectMailAddresses(parsed.cc),
    ...collectMailAddresses(parsed.bcc),
  ];
}

/**
 * The one privileged-keyword decision for a parsed email, called by the PST
 * analyzer and by the Files engine alike, so the same message gets the same
 * answer wherever it sits: keyword in the subject or body (signature and
 * confidentiality notice ignored), unless it was sent to the subject's
 * personal address.
 */
export function discardedForKeyword(
  parsed: ParsedMail,
  personalEmail: string | undefined,
): boolean {
  return (
    hasPrivilegedKeyword(parsed.subject || "", parsed.text || "") &&
    !isSentToPersonalAddress(mailRecipients(parsed), personalEmail)
  );
}
