import type { FilesAiCriteria } from "./files-ai-prompt";

export interface SampleLimits {
  maxChars: number;
  headChars: number;
  maxMentionLines: number;
  maxLineChars: number;
}

export const SAMPLE_LIMITS: SampleLimits = {
  maxChars: 6000,
  headChars: 3000,
  maxMentionLines: 25,
  maxLineChars: 300,
};

export function subjectMentionTokens(criteria: FilesAiCriteria): string[] {
  const tokens = new Set<string>();
  for (const value of [
    criteria.name,
    criteria.email,
    criteria.personalEmail ?? "",
    ...criteria.aliases,
  ]) {
    const token = value.trim().toLowerCase();
    if (token) tokens.add(token);
  }
  return [...tokens];
}

export function buildSample(
  text: string,
  mentionTokens: string[],
  limits: SampleLimits = SAMPLE_LIMITS,
): { text: string; sampled: boolean } {
  // Anything that does not fit is sampled: head plus the lines that mention the
  // subject. Cutting it off at maxChars hid mentions further down and the model
  // then discarded long chats the subject took part in.
  if (text.length <= limits.maxChars) return { text, sampled: false };
  const head = text.slice(0, limits.headChars);
  const budget = limits.maxChars - head.length;
  const mentions: string[] = [];
  let used = 0;
  for (const line of text.slice(limits.headChars).split("\n")) {
    if (mentions.length >= limits.maxMentionLines) break;
    const lower = line.toLowerCase();
    if (!mentionTokens.some((token) => lower.includes(token))) continue;
    const clipped = line.slice(0, limits.maxLineChars);
    if (used + clipped.length + 1 > budget) break;
    mentions.push(clipped);
    used += clipped.length + 1;
  }
  return {
    text: mentions.length > 0 ? `${head}\n…\n${mentions.join("\n")}` : head,
    sampled: true,
  };
}

/**
 * True when the file plainly involves the subject, so it is kept without asking
 * the AI: it contains one of their email addresses, or a line that starts with
 * their name or an alias as the author or speaker ("Name <email> 6/1/2026",
 * "Name 25:47", "Message edited: Name ..."). A name that merely appears in the
 * body of a text still goes to the AI to separate coincidental matches.
 */
export function subjectClearlyInvolved(
  text: string,
  criteria: FilesAiCriteria,
): boolean {
  const lower = text.toLowerCase();
  for (const email of [criteria.email, criteria.personalEmail ?? ""]) {
    const token = email.trim().toLowerCase();
    if (token && lower.includes(token)) return true;
  }
  const names = [criteria.name, ...criteria.aliases]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return false;
  return lower.split("\n").some((line) => {
    const trimmed = line.trim().replace(/^message edited:\s*/, "");
    return names.some(
      (name) =>
        trimmed.startsWith(name) &&
        /^(\s*<|\s+\d{1,2}:\d{2}|\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\s*:)/.test(
          trimmed.slice(name.length),
        ),
    );
  });
}
