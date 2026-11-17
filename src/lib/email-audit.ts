import {
  SENSITIVITY_CATEGORIES,
  SENSITIVITY_RULES,
  type Sensitivity,
} from "./files-ai-prompt";

/** Added to the email audit prompt: confidential mail is never delivered. */
export const EMAIL_CONFIDENTIALITY_PROMPT = `
  5. [CONFIDENTIALITY - overrides everything above]
Also judge whether the email (first_email, second_email and rest_of_chain) contains confidential material that must never be delivered, and report it in "sensitivity". A confidential email is always "discard", even when the subject is plainly involved, and needs_second_pass must be false. The exception: confidential material that is ABOUT the data subject themselves (their grievance and its outcome, appraisal, discipline, health or HR matters) is the subject's own personal data, so report sensitivity "none" and keep it. Confidentiality applies to material that is not about the subject.

${SENSITIVITY_RULES}`;

/** `sensitivity` field of the audit response schema. */
export const SENSITIVITY_SCHEMA = {
  type: "string",
  enum: [...SENSITIVITY_CATEGORIES],
} as const;

/**
 * The confidential category the model reported, or null. A missing or unknown
 * value counts as "none" so a batch submitted before this field existed, or a
 * malformed answer, behaves as it always did (the audit already discards on
 * doubt).
 */
export function confidentialCategory(value: unknown): Sensitivity | null {
  if (typeof value !== "string") return null;
  if (!(SENSITIVITY_CATEGORIES as readonly string[]).includes(value))
    return null;
  return value === "none" ? null : (value as Sensitivity);
}

/** Folds the confidentiality answer into a first-pass audit decision. */
export function applyConfidentiality(input: {
  decision: "keep" | "discard";
  reason: string;
  needsSecondPass: boolean;
  sensitivity: unknown;
}): {
  decision: "keep" | "discard";
  reason: string;
  needsSecondPass: boolean;
  confidential: boolean;
} {
  const category = confidentialCategory(input.sensitivity);
  if (!category) {
    return {
      decision: input.decision,
      reason: input.reason,
      needsSecondPass: input.needsSecondPass,
      confidential: false,
    };
  }
  return {
    decision: "discard",
    reason: `Confidential (${category}): ${input.reason}`.slice(0, 240),
    needsSecondPass: false,
    confidential: true,
  };
}
