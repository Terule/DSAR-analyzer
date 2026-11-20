import assert from "node:assert/strict";
import test from "node:test";
import {
  resultSummaryBody,
  resultSummaryPath,
} from "../../../src/lib/onetrust-attachments";

test("files are attached through the v2 endpoint", () => {
  assert.equal(
    resultSummaryPath("abc/123"),
    "/api/datasubject/v2/datadiscovery/requestqueues/abc%2F123",
  );
});

test("an attachment names the file and its id", () => {
  assert.deepEqual(resultSummaryBody("AIDA", "a.pdf", "file-1"), {
    system: "AIDA",
    results: {},
    attachments: [{ fileName: "a.pdf", fileId: "file-1" }],
  });
});

import {
  attachedFileIds,
  emailMetadata,
  emailNumberFromPath,
  ledgerHashesByNumber,
  retryDelayMs,
} from "../../../src/lib/onetrust-attachments";

test("an email attachment carries its subject and sent date", () => {
  const body = resultSummaryBody("AIDA", "a.pdf", "f", {
    emlSubject: "Q3 budget",
    sendDate: "2026-03-12T10:00:00.000Z",
  });
  assert.deepEqual(body.attachments[0], {
    fileName: "a.pdf",
    fileId: "f",
    emlAttachmentMetadata: {
      emlSubject: "Q3 budget",
      sendDate: "2026-03-12T10:00:00.000Z",
    },
  });
});

test("metadata skips what is missing or not a date", () => {
  assert.equal(emailMetadata(null, "no-date"), undefined);
  assert.deepEqual(emailMetadata(" Hi ", "no-date"), { emlSubject: "Hi" });
  assert.deepEqual(emailMetadata("", "2026-03-12T10:00:00Z"), {
    sendDate: "2026-03-12T10:00:00.000Z",
  });
});

test("only top-level Email PDFs have a number", () => {
  assert.equal(emailNumberFromPath("Emails/Email 0412.pdf"), 412);
  assert.equal(emailNumberFromPath("Emails/Warning/Email 0412.pdf"), null);
  assert.equal(emailNumberFromPath("Documents/Document 1.pdf"), null);
});

test("the ledger maps numbers to hashes and ignores bad lines", () => {
  const map = ledgerHashesByNumber(
    '{"h":"aaa","n":1}\n{"h":"bbb","skip":true}\nnot json\n{"h":"ccc","n":3}\n{"h":"dd',
  );
  assert.deepEqual(
    [...map],
    [
      [1, "aaa"],
      [3, "ccc"],
    ],
  );
});

test("rate limit waits follow Retry-After, bounded", () => {
  assert.equal(retryDelayMs("7", 0), 7000);
  assert.equal(retryDelayMs("9999", 0), 120_000);
  assert.equal(retryDelayMs(null, 0), 2000);
  assert.equal(retryDelayMs(null, 10), 30_000);
});

test("file ids already attached come from every group", () => {
  const ids = attachedFileIds([
    { dataDiscoveryAttachmentListDtos: [{ fileId: "a" }, {}] },
    {},
    { dataDiscoveryAttachmentListDtos: [{ fileId: "b" }] },
  ]);
  assert.deepEqual([...ids].sort(), ["a", "b"]);
});
