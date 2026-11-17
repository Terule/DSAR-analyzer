import { AI_MODEL, AI_REASONING_EFFORT } from "./ai-model";

export interface FilesAiCriteria {
  name: string;
  email: string;
  personalEmail?: string;
  aliases: string[];
}

export const FILES_AI_MODEL = AI_MODEL;

/** What the model may report as the kind of confidential data a file holds. */
export const SENSITIVITY_CATEGORIES = [
  "none",
  "payroll_compensation",
  "legal_privileged",
  "hr_investigation_or_discipline",
  "third_party_personal_data",
  "other_confidential",
] as const;
export type Sensitivity = (typeof SENSITIVITY_CATEGORIES)[number];

/** `client` and `mail` judge confidentiality only; `mail` is for email bodies and attachments. */
export type FilesAiMode = "employee" | "client" | "mail";
export type FilesAiVerdictValue = "keep" | "discard" | "review";

export const FILES_AI_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "files_screening_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["relevance", "sensitivity", "reason"],
      properties: {
        relevance: { type: "string", enum: ["relevant", "irrelevant"] },
        sensitivity: { type: "string", enum: [...SENSITIVITY_CATEGORIES] },
        reason: { type: "string", maxLength: 240 },
      },
    },
  },
} as const;

export const SENSITIVITY_RULES = `Sensitivity (confidential content that must never be delivered):
- "payroll_compensation": salary, bonus, pay, benefits or compensation data, especially a table or list covering several people.
- "legal_privileged": legal advice, attorney-client or litigation material (including court orders and filings) that is not the data subject's own. A document that belongs to the subject is "none": it was written to them, sent by them or made on their behalf, such as their retainer or engagement letter, their claim letter or legal advice addressed to them. Court orders, internal legal analysis and advice that was never sent to the subject stay "legal_privileged".
- "hr_investigation_or_discipline": investigations, grievances, performance reviews or disciplinary records about people.
- "third_party_personal_data": personal data of other people (ID numbers, health, bank details) that is not the subject's own.
- "other_confidential": anything else clearly confidential, restricted, or marked as such.
- "none": nothing of the above.
A file is NOT sensitive merely because it names the data subject. The subject's own data about themselves (their own payslip, contract or offer letter) is "none". A file that holds other people's compensation or personal data is sensitive even when it also mentions the subject. A draft or earlier version of a file that is normally protected is judged by its content, not by whether it carries a password.`;

export function buildFilesAiSystemPrompt(
  criteria: FilesAiCriteria,
  mode: FilesAiMode = "employee",
): string {
  if (mode !== "employee") {
    return `You are an expert Legal AI screening documents, emails and chat messages before they are delivered.
Decide only whether the file contains confidential data that must not be delivered.

${SENSITIVITY_RULES}

Relevance is not being assessed here: always answer "relevant".
Return JSON: {"relevance":"relevant","sensitivity":"<category>","reason":"<one sentence>"}.`;
  }
  return `You are an expert Legal AI performing a Data Subject Access Request (DSAR) review of documents and chat messages.
Target Data Subject: ${criteria.name}
Primary Email (work): ${criteria.email}${criteria.personalEmail ? `\nPersonal Email: ${criteria.personalEmail}` : ""}
Aliases: ${criteria.aliases.join(", ")}

You receive one file (or, when marked SAMPLE, the start of a large file plus lines that mention the subject). Make two independent judgements.

Relevance: is the file about the Data Subject, written by them, sent to them, or does it contain their personal data in a way that matters to a subject access request.
- Answer "irrelevant" ONLY when the file is clearly unrelated to the Data Subject (for example a coincidental name match, a generic template, a system export that merely lists many people).
- When in doubt about relevance, answer "relevant". A SAMPLE that shows the subject in a meaningful context means "relevant" for the whole file.

${SENSITIVITY_RULES}

Return JSON: {"relevance":"relevant"|"irrelevant","sensitivity":"<category>","reason":"<one sentence>"}.`;
}

export function buildFilesAiUserContent(input: {
  fileName: string;
  kind: "Document" | "Message";
  sampled: boolean;
  text: string;
}): string {
  return `${input.sampled ? "SAMPLE of a large file" : "Full file text"} (${input.kind}): ${input.fileName}\n---\n${input.text}`;
}

export function buildFilesAiBatchRequest(input: {
  customId: string;
  systemPrompt: string;
  userContent: string;
}): object {
  return {
    custom_id: input.customId,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: FILES_AI_MODEL,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userContent },
      ],
      temperature: 0,
      reasoning_effort: AI_REASONING_EFFORT,
      max_completion_tokens: 120,
      response_format: FILES_AI_RESPONSE_FORMAT,
    },
  };
}

export interface FilesAiJudgement {
  relevance: "relevant" | "irrelevant" | null;
  sensitivity: Sensitivity | null;
  reason: string;
}

/** Anything that is not a well-formed answer has no judgement: a person decides. */
export const NO_JUDGEMENT: FilesAiJudgement = {
  relevance: null,
  sensitivity: null,
  reason: "Unparseable AI output; needs human review.",
};

export function parseFilesAiJudgement(raw: unknown): FilesAiJudgement {
  if (typeof raw !== "string") return NO_JUDGEMENT;
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const data = JSON.parse(cleaned) as Record<string, unknown>;
    const relevance = data.relevance;
    const sensitivity = data.sensitivity;
    if (
      (relevance !== "relevant" && relevance !== "irrelevant") ||
      typeof sensitivity !== "string" ||
      !(SENSITIVITY_CATEGORIES as readonly string[]).includes(sensitivity)
    ) {
      return NO_JUDGEMENT;
    }
    return {
      relevance,
      sensitivity: sensitivity as Sensitivity,
      reason: typeof data.reason === "string" ? data.reason.slice(0, 240) : "",
    };
  } catch {
    return NO_JUDGEMENT;
  }
}

/**
 * Turns the model's judgement into what happens to the file.
 *  - no usable judgement                      -> review (a person decides)
 *  - confidential (any case type)             -> discard
 *  - irrelevant (employee cases only)         -> discard
 *  - relevant but too large to read in full   -> review
 *  - otherwise                                -> keep
 * `subjectInvolved` (the subject is plainly an author, speaker or addressee)
 * overrides an "irrelevant" answer, as before; it never overrides sensitivity.
 */
export function decideFilesAi(input: {
  judgement: FilesAiJudgement;
  mode: FilesAiMode;
  largeFile: boolean;
  subjectInvolved: boolean;
}): { verdict: FilesAiVerdictValue; reason: string } {
  const { judgement, mode, largeFile, subjectInvolved } = input;
  if (judgement.relevance === null || judgement.sensitivity === null) {
    return { verdict: "review", reason: judgement.reason };
  }
  if (judgement.sensitivity !== "none") {
    return {
      verdict: "discard",
      reason:
        `Confidential (${judgement.sensitivity}): ${judgement.reason}`.slice(
          0,
          240,
        ),
    };
  }
  if (
    mode === "employee" &&
    judgement.relevance === "irrelevant" &&
    !subjectInvolved
  ) {
    return { verdict: "discard", reason: judgement.reason };
  }
  if (largeFile) {
    return {
      verdict: "review",
      reason:
        `Large file judged from a sample; needs human review. ${judgement.reason}`.slice(
          0,
          240,
        ),
    };
  }
  return { verdict: "keep", reason: judgement.reason };
}
