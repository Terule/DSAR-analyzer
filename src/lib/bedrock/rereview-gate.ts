import { createHash } from "node:crypto";

/** Categories Haiku 4.5 is known to over-apply to the subject's own material. */
const DOUBTFUL_CATEGORIES = [
  "legal_privileged",
  "hr_investigation_or_discipline",
];

/** A deterministic share of ids (so a retry picks the same ones): the control sample. */
export function inControlSample(id: string, rate: number): boolean {
  if (rate <= 0) return false;
  const bucket = createHash("sha256").update(id).digest().readUInt32BE(0);
  return bucket / 0xffffffff < rate;
}

/**
 * Whether a Haiku 4.5 DISCARD gets a second opinion from Haiku 5.5. Obvious
 * discards stay final, which keeps the cost down on very large cases. Review
 * when any of these holds: the model shows doubt (p_keep at or above the
 * threshold, or no estimate at all), the discard rests on a category 4.5 tends
 * to over-apply, the subject is plainly involved, or the id falls in the
 * random control sample that measures what the filter lets through.
 */
export function shouldRereview(
  input: {
    id: string;
    pKeep: number | null | undefined;
    sensitivity: string | null;
    subjectInvolved: boolean;
  },
  config: { minPKeep: number; sampleRate: number },
): boolean {
  if (input.pKeep === null || input.pKeep === undefined) return true;
  if (input.pKeep >= config.minPKeep) return true;
  if (input.sensitivity && DOUBTFUL_CATEGORIES.includes(input.sensitivity)) {
    return true;
  }
  if (input.subjectInvolved) return true;
  return inControlSample(input.id, config.sampleRate);
}
