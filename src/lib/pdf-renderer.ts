// Legacy compatibility layer.
//
// The project now uses the WeasyPrint-based converter implementation.
// Keep this module to preserve old imports without reviving Puppeteer.

export {
  convertToPdfBatch,
  extractPdfText,
  processDocxToPdf,
  processExcelToPdf,
  processPdfAttachment,
} from "./converter";
