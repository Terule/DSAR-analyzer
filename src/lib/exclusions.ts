import { stripEmailSignature } from "./email-content";

/**
 * Privileged / confidential keywords that force an immediate discard.
 *
 * Centralized so the PST pipeline (analyzer + AI pre-filter, `src/lib/analyzer.ts`
 * and `src/lib/ai.ts`) and the Files pipeline (`src/lib/standalone-processor.ts`)
 * always use the exact same rule and never drift apart.
 */
export const PRIVILEGED_KEYWORDS = [
  "Confidential",
  "Confidentiality",
  "Privileged",
  "CRO",
  "CROs",
] as const;

/**
 * Token-boundary match (not substring) so e.g. "MICROSOFT" never triggers the
 * "CRO" exclusion. Case-insensitive; safe to `.test()` against raw or
 * lowercased text. Built from PRIVILEGED_KEYWORDS so the list and the matcher
 * cannot diverge.
 */
export const PRIVILEGED_KEYWORDS_RE = new RegExp(
  `(?<![A-Za-z0-9])(${PRIVILEGED_KEYWORDS.join("|")})(?![A-Za-z0-9])`,
  "i",
);

/**
 * The ONE keyword rule for every email, wherever it sits (PST or the Files
 * folder): the privileged keywords are looked up in the subject and the body,
 * ignoring the signature / confidentiality disclaimer, which says
 * "confidential" on nearly every corporate email.
 */
export function hasPrivilegedKeyword(subject: string, body: string): boolean {
  return PRIVILEGED_KEYWORDS_RE.test(
    stripEmailSignature(`${subject}\n${body}`),
  );
}
