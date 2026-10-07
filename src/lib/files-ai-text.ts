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

/** Extracted text longer than this is sampled instead of sent (truncated) whole. */
export const LARGE_TEXT_CHARS = 60_000;

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
  if (text.length <= LARGE_TEXT_CHARS) {
    return { text: text.slice(0, limits.maxChars), sampled: false };
  }
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
