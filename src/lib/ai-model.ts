/**
 * The model behind every AI step (email audit, its attachments second pass and
 * the Files relevance check). Luna reasons by default, which rejects
 * `temperature: 0` and spends the small output cap on thinking, so every
 * request sets `reasoning_effort: "none"`.
 */
export const AI_MODEL = "gpt-6-luna";
export const AI_REASONING_EFFORT = "none" as const;

/** js-tiktoken has no entry for Luna; token estimates use gpt-4o-mini's encoding. */
export const AI_TOKENIZER_MODEL = "gpt-4o-mini";
