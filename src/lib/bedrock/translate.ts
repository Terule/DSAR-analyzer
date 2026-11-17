import { MIN_OUTPUT_TOKENS } from "./config";

/** A Files AI request line as `buildFilesAiBatchRequest` writes it (OpenAI chat format). */
export interface ParsedRequest {
  customId: string;
  system: string;
  user: string;
  toolName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export function parseRequestLine(line: string): ParsedRequest {
  const parsed = JSON.parse(line) as {
    custom_id: string;
    body: {
      messages: { role: string; content: string }[];
      max_completion_tokens?: number;
      response_format: {
        json_schema: { name: string; schema: Record<string, unknown> };
      };
    };
  };
  const messages = parsed.body.messages;
  const schema = parsed.body.response_format.json_schema;
  return {
    customId: parsed.custom_id,
    system: messages.find((m) => m.role === "system")?.content ?? "",
    user: messages.find((m) => m.role === "user")?.content ?? "",
    toolName: schema.name,
    schema: schema.schema,
    maxTokens: Math.max(
      parsed.body.max_completion_tokens ?? 0,
      MIN_OUTPUT_TOKENS,
    ),
  };
}

/** Added to Haiku 4.5 batch requests so its discards can be triaged for a second look. */
export const CONFIDENCE_INSTRUCTION = `

Also report "confidence": an integer from 0 to 100 giving the probability that this file SHOULD BE KEPT (delivered). 0 = certainly discard, 100 = certainly keep. Use the whole range: pick a middle value when the rules do not clearly decide.`;

function withConfidence(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(schema)) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  copy.properties.confidence = { type: "integer", minimum: 0, maximum: 100 };
  copy.required = [...copy.required, "confidence"];
  return copy as unknown as Record<string, unknown>;
}

/** Anthropic Messages body for a Bedrock Batch record, with a forced tool for structured output. */
export function toBatchModelInput(request: ParsedRequest): object {
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: request.maxTokens,
    system: request.system + CONFIDENCE_INSTRUCTION,
    messages: [{ role: "user", content: request.user }],
    tools: [
      {
        name: request.toolName,
        description: "Report the screening decision for this file.",
        input_schema: withConfidence(request.schema),
      },
    ],
    tool_choice: { type: "tool", name: request.toolName },
  };
}

/** The tool input from a Bedrock Batch `modelOutput` (Anthropic Messages response). */
export function toolInputFromModelOutput(modelOutput: unknown): unknown {
  const content = (
    modelOutput as { content?: { type: string; input?: unknown }[] }
  )?.content;
  return content?.find((block) => block.type === "tool_use")?.input;
}

/**
 * One line in the shape the Files AI poller already reads (OpenAI batch output).
 * A missing tool input produces no content, which the parser turns into review.
 */
export function toOpenAiOutputLine(
  customId: string,
  toolInput: unknown,
): string {
  return JSON.stringify({
    custom_id: customId,
    response: {
      body: {
        choices: [
          {
            message: {
              content: toolInput === undefined ? "" : JSON.stringify(toolInput),
            },
          },
        ],
      },
    },
  });
}
