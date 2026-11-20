import {
  stripConfidentialityNotice,
  stripEmailSignature,
} from "./email-content";

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

/**
 * The same keyword rule for every file (docx, pdf, spreadsheet, chat export,
 * text) and attachment: the standard confidentiality notice is ignored, the
 * rest of the text counts.
 */
export function hasPrivilegedKeywordInDocument(text: string): boolean {
  return PRIVILEGED_KEYWORDS_RE.test(stripConfidentialityNotice(text));
}

/**
 * A privileged/confidential keyword in a document's file name ("Confidential -
 * board minutes.docx", "Privileged_advice.pdf"). Separators count as spaces so
 * the whole-word match still finds the word. Messages are judged by their
 * content, not by the name of the export.
 */
export function hasPrivilegedKeywordInFileName(fileName: string): boolean {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return PRIVILEGED_KEYWORDS_RE.test(base.replace(/[_.\-+]+/g, " "));
}
