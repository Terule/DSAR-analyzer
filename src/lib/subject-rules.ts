/**
 * One definition of "this item cites the data subject", used for emails,
 * attachments, files and chat messages alike (docs/pipeline-refactor.md, step 1).
 *
 * The token set is deliberately broad (err toward keeping): the full name, the
 * first and last name on their own, aliases, both email addresses and their
 * local parts. A match only means "worth a closer look"; the AI and the human
 * review decide whether the item is really about the subject.
 */

export interface SubjectIdentity {
  name?: string;
  email?: string;
  personalEmail?: string;
  aliases?: string[];
}

/** Shortest first name, last name or local part that counts as a token. */
const MIN_PARTIAL_LENGTH = 3;

function clean(value: string | undefined): string {
  return (value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Identifiers that single out the subject: full name, aliases and email
 * addresses, without a first or last name on its own. Spreadsheets use these,
 * because a whole row is delivered and a row that only shares a first name is
 * most likely someone else's.
 */
export function buildSubjectIdentifiers(identity: SubjectIdentity): string[] {
  const identifiers = new Set<string>();
  for (const value of [
    identity.name,
    ...(identity.aliases || []),
    identity.email,
    identity.personalEmail,
  ]) {
    const cleaned = clean(value);
    if (cleaned) identifiers.add(cleaned);
  }
  return [...identifiers];
}

export function buildSubjectTokens(identity: SubjectIdentity): string[] {
  const tokens = new Set<string>();

  const name = clean(identity.name);
  if (name) {
    tokens.add(name);
    const parts = name.split(" ").filter(Boolean);
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first && first.length >= MIN_PARTIAL_LENGTH) tokens.add(first);
    if (last && last.length >= MIN_PARTIAL_LENGTH) tokens.add(last);
  }

  for (const alias of identity.aliases || []) {
    const value = clean(alias);
    if (value) tokens.add(value);
  }

  for (const address of [identity.email, identity.personalEmail]) {
    const value = clean(address);
    if (!value) continue;
    tokens.add(value);
    const local = value.split("@")[0];
    if (local && local.length >= MIN_PARTIAL_LENGTH) tokens.add(local);
  }

  return [...tokens];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const matcherCache = new Map<string, RegExp[]>();

function matchersFor(tokens: string[]): RegExp[] {
  const key = tokens.join("\u0000");
  let matchers = matcherCache.get(key);
  if (!matchers) {
    matchers = tokens
      .filter(Boolean)
      .map(
        (token) =>
          new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}($|[^a-z0-9])`, "i"),
      );
    if (matcherCache.size > 64) matcherCache.clear();
    matcherCache.set(key, matchers);
  }
  return matchers;
}

/**
 * True when the text contains one of the tokens as a whole word ("ana" does not
 * match "banana"). With no tokens (client cases keep everything) it is true.
 */
export function mentionsSubject(text: string, tokens: string[]): boolean {
  const matchers = matchersFor(tokens);
  if (matchers.length === 0) return true;
  return matchers.some((matcher) => matcher.test(text));
}
