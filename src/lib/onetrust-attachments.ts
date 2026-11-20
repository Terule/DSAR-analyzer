/**
 * How a delivered file is attached to a OneTrust request. Client-case files
 * must go through redaction in OneTrust, so every attachment is marked
 * `isRedact: true`; only the v3 Results Summary endpoint carries that flag
 * (the v2 one has no per-file redaction field).
 */
export function resultSummaryPath(requestId: string): string {
  return `/api/datasubject/v3/datadiscovery/requestqueues/${encodeURIComponent(requestId)}`;
}

export function resultSummaryBody(
  system: string,
  attachmentName: string,
  fileId: string,
) {
  return {
    system,
    // The Results Summary API requires the dataset container even when this
    // integration contributes only document attachments.
    results: {},
    attachments: [{ fileName: attachmentName, fileId, isRedact: true }],
  };
}
