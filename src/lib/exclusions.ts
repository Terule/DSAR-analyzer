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
