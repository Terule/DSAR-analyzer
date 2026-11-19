/**
 * Remove the non-substantive tail of an email before it is used for relevance
 * matching or AI input. Rendered deliverables retain the original message.
 */
export function stripEmailSignature(text: string): string {
  if (!text) return "";
  const normalized = text.replace(/\r\n?/g, "\n");
  const markers = [
    /^--\s*$/m,
    /^sent from my\b/im,
    /^(?:kind|best|warm) regards[,!]?\s*$/im,
    /^(?:many )?thanks[,!]?\s*$/im,
    /^(?:yours|sincerely)[,!]?\s*$/im,
    /^this (?:e-?mail|email|message)(?: and any attachments?)?\b.*\b(?:confidential|privileged)\b/im,
    /^confidentiality (?:notice|disclaimer)\b/im,
  ];

  const cutAt = markers.reduce((earliest, marker) => {
    const match = marker.exec(normalized);
    return typeof match?.index === "number"
      ? Math.min(earliest, match.index)
      : earliest;
  }, normalized.length);

  return normalized.slice(0, cutAt).trim();
}

const NOTICE_MARKERS = [
  /^this (?:e-?mail|email|message)(?: and any attachments?)?\b.*\b(?:confidential|privileged)\b/im,
  /^confidentiality (?:notice|disclaimer)\b/im,
];

/**
 * For documents (docx, pdf, spreadsheets, chat exports, text): drop only the
 * standard confidentiality notice and what follows it. Sign-offs such as
 * "Thanks," are not cut points here, because in a long document they say
 * nothing about where the substance ends.
 */
export function stripConfidentialityNotice(text: string): string {
  if (!text) return "";
  const normalized = text.replace(/\r\n?/g, "\n");
  const cutAt = NOTICE_MARKERS.reduce((earliest, marker) => {
    const match = marker.exec(normalized);
    return typeof match?.index === "number"
      ? Math.min(earliest, match.index)
      : earliest;
  }, normalized.length);
  return normalized.slice(0, cutAt);
}
