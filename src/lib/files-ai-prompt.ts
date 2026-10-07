export interface FilesAiCriteria {
  name: string;
  email: string;
  personalEmail?: string;
  aliases: string[];
}

export const FILES_AI_MODEL = "gpt-4o-mini";

export const FILES_AI_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "dsar_files_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "reason"],
      properties: {
        decision: { type: "string", enum: ["keep", "discard"] },
        reason: { type: "string", maxLength: 240 },
      },
    },
  },
} as const;

export function buildFilesAiSystemPrompt(criteria: FilesAiCriteria): string {
  return `You are an expert Legal AI performing a Data Subject Access Request (DSAR) relevance review of documents and chat messages.
Target Data Subject: ${criteria.name}
Primary Email (work): ${criteria.email}${criteria.personalEmail ? `\nPersonal Email: ${criteria.personalEmail}` : ""}
Aliases: ${criteria.aliases.join(", ")}

You receive one file (or, when marked SAMPLE, the start of a large file plus lines that mention the subject). Decide whether the file is relevant to the Data Subject: it is about them, written by them, sent to them, or contains their personal data in a way that matters to a subject access request.

Rules:
- Answer "discard" ONLY when the file is clearly unrelated to the Data Subject (for example a coincidental name match, a generic template, a system export that merely lists many people).
- When in doubt, answer "keep". Missing a relevant file is worse than keeping an irrelevant one.
- A SAMPLE that shows the subject in a meaningful context means "keep" for the whole file.
Return JSON: {"decision":"keep"|"discard","reason":"<one sentence>"}.`;
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
      max_completion_tokens: 120,
      response_format: FILES_AI_RESPONSE_FORMAT,
    },
  };
}

const KEEP_FALLBACK = {
  verdict: "keep" as const,
  reason: "Unparseable AI output; kept.",
};

/** Anything that is not an explicit keep/discard answer is a keep. */
export function parseFilesAiVerdict(raw: unknown): {
  verdict: "keep" | "discard";
  reason: string;
} {
  if (typeof raw !== "string") return KEEP_FALLBACK;
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const data = JSON.parse(cleaned) as {
      decision?: unknown;
      reason?: unknown;
    };
    if (data.decision !== "keep" && data.decision !== "discard") {
      return KEEP_FALLBACK;
    }
    const reason =
      typeof data.reason === "string" ? data.reason.slice(0, 240) : "";
    return { verdict: data.decision, reason };
  } catch {
    return KEEP_FALLBACK;
  }
}
