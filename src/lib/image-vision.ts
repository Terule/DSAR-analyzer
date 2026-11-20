/**
 * Layer 5 of docs/pipeline-refactor.md section 4.4: a vision model looks at an
 * image the cheap layers (shape, name, recurrence) could not place, and says
 * whether it is a signature or decoration. It only ever REMOVES a picture that
 * is clearly decoration; anything else, any doubt and any failure leaves the
 * image to a person (the audit errs toward keeping).
 *
 * Haiku 5.5 on Converse, `eu.` profile, region eu-central-1. The model sees the
 * image and nothing else: no subject, no sender, no file name.
 */
import { createHash } from "node:crypto";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { CONVERSE_MODEL } from "./bedrock/config";
import { awsBedrockDeps } from "./bedrock/files-ai-client";
import type { ParsedRequest } from "./bedrock/translate";
import { getAiBatchSettings } from "./pipeline-settings";

export type VisionConverse = (
  request: ParsedRequest,
  modelId: string,
) => Promise<unknown>;

export interface VisionVerdict {
  /** `decoration` removes the image; `unsure` leaves it to a person. */
  verdict: "decoration" | "unsure";
  reason: string;
}

export const imageVisionTestOverride: { converse?: VisionConverse } = {};

/** Converse accepts images up to 3.75 MB. */
const MAX_BYTES = 3_750_000;
const CACHE_LIMIT = 5_000;
const cache = new Map<string, VisionVerdict>();

const SYSTEM = `You look at one image that came with an email or was found in a document folder, for a data-subject access request review. Say whether it is only a signature graphic or decoration.

Answer "decoration" (confident) only when the image is clearly one of these and carries no information: a company logo, an email signature graphic, a social-media or contact icon, a banner, a divider line, a tracking pixel, an emoji, a default avatar, a background texture.

Everything else is "content": a photo of a document or ID, a screenshot, a scan, a chart or table, a photo of a person or a place, a handwritten note, or any image with readable text beyond a company name. When you are not sure, answer "content". Do not describe people.`;

const SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["decoration", "content"] },
    confident: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["category", "confident", "reason"],
  additionalProperties: false,
};

const FORMATS: Array<{
  format: "png" | "jpeg" | "gif" | "webp";
  matches: (b: Buffer) => boolean;
}> = [
  {
    format: "png",
    matches: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
  },
  {
    format: "jpeg",
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
  },
  {
    format: "gif",
    matches: (b) => b.length > 6 && b.toString("ascii", 0, 3) === "GIF",
  },
  {
    format: "webp",
    matches: (b) =>
      b.length > 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
];

async function resolveConverse(): Promise<VisionConverse | undefined> {
  if (imageVisionTestOverride.converse) return imageVisionTestOverride.converse;
  try {
    await defaultProvider()();
    return awsBedrockDeps().converse;
  } catch {
    return undefined;
  }
}

const unsure = (reason: string): VisionVerdict => ({
  verdict: "unsure",
  reason,
});

/**
 * Judges one image. `enabled` is the AI screening switch (System settings);
 * when it is off, or credentials are missing, or anything goes wrong, the
 * answer is `unsure` and a person decides.
 */
export async function judgeImageWithVision(
  content: Buffer,
  options: { enabled: boolean },
): Promise<VisionVerdict> {
  if (!options.enabled) return unsure("AI screening is off.");
  const format = FORMATS.find((entry) => entry.matches(content))?.format;
  if (!format) return unsure("Image format is not readable by the model.");
  if (content.length > MAX_BYTES)
    return unsure("Image is too large for the model.");

  const key = createHash("sha256").update(content).digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;

  const converse = await resolveConverse();
  if (!converse) return unsure("No AWS credentials for the vision model.");
  let verdict: VisionVerdict;
  try {
    const raw = (await converse(
      {
        customId: `img-${key.slice(0, 12)}`,
        system: SYSTEM,
        user: "Classify this image.",
        toolName: "image_class",
        schema: SCHEMA,
        maxTokens: 200,
        image: { format, bytes: new Uint8Array(content) },
      },
      CONVERSE_MODEL,
    )) as
      | { category?: string; confident?: boolean; reason?: string }
      | undefined;
    if (raw?.category === "decoration" && raw.confident === true) {
      verdict = {
        verdict: "decoration",
        reason: (raw.reason || "decoration").slice(0, 160),
      };
    } else {
      verdict = unsure(raw?.reason?.slice(0, 160) || "Content or unclear.");
    }
  } catch (error) {
    console.error(
      "[Image vision] Call failed:",
      (error as { name?: string }).name,
    );
    return unsure("The vision model could not be reached.");
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, verdict);
  return verdict;
}

/** For tests: forget what was judged. */
export function clearImageVisionCache(): void {
  cache.clear();
}

let enabledAt = 0;
let enabledValue = true;

/** The AI screening switch, read at most every 30 seconds (an image folder has thousands). */
export async function visionEnabled(): Promise<boolean> {
  if (Date.now() - enabledAt < 30_000) return enabledValue;
  try {
    enabledValue = (await getAiBatchSettings()).filesAiEnabled !== false;
  } catch {
    // Settings unreadable: do not use the model, a person decides.
    return false;
  }
  enabledAt = Date.now();
  return enabledValue;
}
