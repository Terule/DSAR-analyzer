/**
 * Heap, in MB, for the thread that converts one spreadsheet or document.
 * It must stay below the container's memory limit: with a 2GB heap inside a
 * 1.5GB container, one oversized workbook made the kernel kill the whole
 * container (and its 100-file batch) before V8 could fail just that file.
 * Two thirds leaves room for Node, the other files in the batch and the PDF
 * renderer.
 */
export function officeHeapMb(containerMb: number): number {
  return Math.max(256, Math.floor((containerMb * 2) / 3));
}
