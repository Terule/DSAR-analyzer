/** Video and audio are never delivered, in any case type (decided 2026-11-20). */
const VIDEO = [
  ".mp4",
  ".m4v",
  ".mov",
  ".avi",
  ".wmv",
  ".mkv",
  ".webm",
  ".mpg",
  ".mpeg",
  ".3gp",
  ".flv",
  ".ts",
  ".mts",
  ".m2ts",
];
const AUDIO = [
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".wma",
  ".ogg",
  ".opus",
  ".flac",
  ".amr",
  ".aiff",
];

const MEDIA = new Set([...VIDEO, ...AUDIO]);

export function isMediaExtension(extension: string): boolean {
  return MEDIA.has(extension.toLowerCase());
}

/** The kind of media behind an extension, for the reason shown in the audit trail. */
export function mediaKind(extension: string): "video" | "audio" | null {
  const ext = extension.toLowerCase();
  if (VIDEO.includes(ext)) return "video";
  if (AUDIO.includes(ext)) return "audio";
  return null;
}
